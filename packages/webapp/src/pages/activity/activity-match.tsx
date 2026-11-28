import type { AttachCandidates, EpisodeRef, FileRow, QueueEntryView, QueueGroupPage, QueueMappingEpisode, QueueMatchPreview, QueuePackFiles, QueueTorrentDetail } from '@ladarr/shared/types';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button, Checkbox, Dropdown, EmptyState, Modal, SearchableDropdown, Spinner, Table, Text } from 'nebula';
import { Confirm } from '../../components/confirm.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { describeError, formatBytes, groupName, seasonName } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';

const errorText = (err: unknown) =>
  err instanceof ApiError && err.message === 'download_not_found'
    ? t('The download folder is not the same as configured as media.')
    : err instanceof ApiError && err.message === 'cover_not_in_download'
      ? t('The download does not hold one of the episodes.')
      : err instanceof ApiError && err.message === 'torrent_in_use'
        ? t('A target of another title uses this download.')
        : err instanceof ApiError && err.message === 'torrent_not_found'
          ? t('The client does not have this download now.')
          : err instanceof ApiError && ['invalid_numbering', 'numbering_changed'].includes(err.message)
            ? describeError(err) : t('The request did not complete.');

const pad = (value: number) => String(value).padStart(2, '0');
const pointText = (point: EpisodeRef) => `S${pad(point.season)}E${pad(point.number)}`;
const sameEpisode = (a: EpisodeRef, b: EpisodeRef) => a.season === b.season && a.number === b.number;
const validSeason = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
type FileSource = QueuePackFiles['source'];
type PackFile = QueuePackFiles['files'][number];
type Draft = { hash?: string; file?: PackFile | null; path?: string };
type Change = { id: string; source: FileSource; hash?: string; file: string; ids: string[]; covers?: EpisodeRef[] };
type Rejected = QueueGroupPage['group']['rejected'][number];
type ReleaseDraft = { season: number; candidate: Rejected; file: string };
type ReleaseSelection = { indexerId: number; guid: string; files: { file: string; ids: string[] }[] };
export type MatchRequest = { entry: QueueEntryView; ids: string[]; entries: QueueEntryView[]; fileSource?: FileSource; fixedSource: boolean; rejected?: Rejected[] };

const manifestPath = ({ entryId, release }: Rejected) =>
  `/queue/entries/${entryId}/releases/torrent?indexerId=${release.indexerId}&guid=${encodeURIComponent(release.guid)}&mapping=true`;

function releaseBatches(assignments: (ReleaseDraft & { id: string })[]) {
  const batches = new Map<number, { id: string; torrents: ReleaseSelection[] }>();
  for (const { id, season, candidate: { entryId, release }, file } of assignments) {
    let batch = batches.get(season);
    if (!batch) {
      batch = { id: entryId, torrents: [] };
      batches.set(season, batch);
    }
    let torrent = batch.torrents.find(({ indexerId, guid }) => indexerId === release.indexerId && guid === release.guid);
    if (!torrent) {
      torrent = { indexerId: release.indexerId, guid: release.guid, files: [] };
      batch.torrents.push(torrent);
    }
    const selected = torrent.files.find((row) => row.file === file);
    if (selected) selected.ids.push(id);
    else torrent.files.push({ file, ids: [id] });
  }
  return batches;
}

const fileOptions = (files: PackFile[]) => [
  { value: '', label: t('Unassigned') },
  ...files.map((file) => ({ value: file.rel, label: `${file.rel} (${formatBytes(file.sizeBytes)})` })),
];

function sourceOf(item: QueueEntryView, fixed?: FileSource) {
  const action = item.actions.find((action) => action.action === 'match');
  const type = fixed ?? action?.fileSource ?? (item.hasTorrent ? 'download' : 'library');
  const own = type === 'download' ? action?.source ?? item.transfer?.hash ?? item.release?.title ?? '' : '';
  return { own, hash: undefined, type, key: own || (type === 'library' ? 'library' : item.id), path: `/queue/entries/${item.id}/files?source=${type}` };
}

function torrentSource(id: string, own: string, selected = own) {
  const hash = selected && selected !== own ? selected : undefined;
  return { hash, type: 'download' as const, key: selected || id, path: selected ? `/queue/entries/${id}/files?source=download${hash ? `&hash=${hash}` : ''}` : null };
}

async function apply({ id, ...body }: Change) {
  const path = `/queue/entries/${id}/match`;
  const preview = await api<QueueMatchPreview>(path, { method: 'POST', body: { ...body, preview: true } });
  if (!preview.version || preview.effects.conflicts.length || preview.effects.lostAvailability.length) throw new ApiError(409, 'mapping_changed');
  await api(path, { method: 'POST', body: { ...body, version: preview.version } });
}

const readout = (text: string) => <div className="truncate" title={text}>{text}</div>;

export function MatchDialog({ entry, ids, entries, fileSource, fixedSource, rejected, onClose, onDone }: MatchRequest & { onClose: () => void; onDone: () => void }) {
  const series = entry.mediaType === 'tv';
  const mapSeries = series && !fixedSource;
  const existing = mapSeries && !rejected;
  const fixed = fixedSource ? fileSource ?? 'library' : undefined;
  const detailId = useId();
  const [expanded, setExpanded] = useState<number[]>(() => entry.season === null ? [] : [entry.season]);
  const [seasons, setSeasons] = useState<Record<string, string>>({});
  const [searchSeasons, setSearchSeasons] = useState<number[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [releases, setReleases] = useState<Record<string, ReleaseDraft | undefined>>({});
  const [movie, setMovie] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const client = useQueryClient();
  const group = useQuery<QueueGroupPage>({
    queryKey: [`/queue/groups/${entry.titleKey}?mapping=${rejected ? 'rejected' : 'true'}${mapSeries ? '' : `&season=${entry.season}`}`],
    enabled: series,
    gcTime: 0,
  });
  const candidates = useQuery<AttachCandidates>({
    queryKey: [`/queue/entries/${entry.id}/external?mapping=true`],
    enabled: existing,
    gcTime: 0,
  });
  const options = (candidates.data?.torrents ?? []).map(({ hash, name }) => ({ value: hash, label: name }));
  const items = new Map(group.data?.items.map((item) => [item.id, item]));
  const editable = new Set(mapSeries ? group.data?.group.actions.filter((action) => action.action === 'match').flatMap((action) => action.ids) : ids);
  const episodes = group.data?.mapping ?? [];
  const rows = mapSeries ? episodes : episodes.filter((point) => point.season === entry.season);
  const pendingRows = rejected ? rows.filter((point) => {
    const item = items.get(point.id);
    if (!item || item.hasTorrent || point.match?.path) return false;
    const waiting = item.phase === 'queued' && ['not_found', 'no_match', 'searching'].includes(item.status);
    return waiting || (item.status === 'stuck' && ['queued', 'searching', 'fetching'].includes(item.phase));
  }) : [];
  const eligible = new Set(pendingRows.map((row) => row.id));
  const otherSeasons = expanded.filter((season) => season !== entry.season && pendingRows.some((row) => row.season === season));
  const seasonGroups = useQueries({
    queries: otherSeasons.map((season) => ({
      queryKey: [`/queue/groups/${entry.titleKey}?season=${season}`],
      queryFn: () => api<QueueGroupPage>(`/queue/groups/${entry.titleKey}?season=${season}`),
    })),
  });
  const rejectedBySeason = new Map(otherSeasons.map((season, index) => [season, seasonGroups[index]!.data?.group.rejected ?? []]));
  if (rejected && entry.season !== null) rejectedBySeason.set(entry.season, rejected);
  const seasonChanged = (point: QueueMappingEpisode) => seasons[point.id] !== undefined && Number(seasons[point.id]) !== point.releaseSeason;
  // An episode that a rejected release holds starts with that release and its file, until the user changes them.
  const selectionOf = (point: QueueMappingEpisode): ReleaseDraft | undefined => {
    if (Object.hasOwn(releases, point.id)) return releases[point.id];
    if (!eligible.has(point.id) || seasonChanged(point)) return undefined;
    const candidate = rejectedBySeason.get(point.season)?.find(({ release }) => release.matches?.[point.id]);
    return candidate && { season: point.season, candidate, file: candidate.release.matches![point.id]! };
  };
  const selections = Object.fromEntries(rows.map((point) => [point.id, selectionOf(point)]));
  const paths = [...new Set(Object.values(selections).flatMap((draft) => draft ? [manifestPath(draft.candidate)] : []))];
  const manifests = useQueries({
    queries: paths.map((path) => ({ queryKey: [path], queryFn: () => api<QueueTorrentDetail>(path), staleTime: Infinity, gcTime: 0 })),
  });
  const releaseFiles = new Map(paths.map((path, i) => [path, manifests[i]!.data?.files]));
  const library = useQuery<{ files: FileRow[] }>({
    queryKey: [`/library/${entry.titleKey}/files`],
    enabled: existing,
    gcTime: 0,
  });
  const matchesByPath = new Map(episodes.flatMap(({ match, torrent }) => match?.path && torrent ? [[match.path, { label: match.file, hash: torrent.hash }] as const] : []));
  const libraryOptions = library.data?.files.flatMap((file) => {
    const match = matchesByPath.get(file.path);
    return !file.missing && match ? [{ value: file.path, ...match }] : [];
  });
  const invalidSeason = Object.values(seasons).some((value) => !validSeason(value));
  const initialSeasons = new Set(rows.flatMap((point) => [point.season, point.releaseSeason]));
  const addedSeasons = [...new Set(rows.map((point) => seasons[point.id]).filter((value) => value !== undefined && validSeason(value)).map(Number))]
    .filter((season) => !initialSeasons.has(season)).sort((a, b) => a - b);
  const knownSeasons = new Set([...initialSeasons, ...addedSeasons]);
  let nextSeason = 1;
  while (knownSeasons.has(nextSeason)) nextSeason++;
  knownSeasons.add(nextSeason);
  const seasonOptions = [...knownSeasons].sort((a, b) => a - b).map((number) => ({ value: String(number) }));
  const sources = new Map<string, string>();
  const initial = new Set<string>();
  const essential = new Set<string>();
  const rowSource = (point: QueueMappingEpisode) => {
    const item = items.get(point.id);
    const draft = drafts[point.id];
    const { torrent, match } = point;
    const hash = draft?.hash ?? torrent?.hash ?? '';
    const path = draft?.hash === undefined ? match?.path : undefined;
    const source = mapSeries ? torrentSource(point.id, torrent?.hash ?? '', hash) : sourceOf(item ?? entry, fixed);
    return { item, draft, torrent, match, hash, path, source };
  };
  const addSource = ({ key, path }: { key: string; path: string | null }) => {
    if (path && !sources.has(key)) sources.set(key, path);
    return key;
  };
  if (!series || fixedSource) {
    const key = addSource(sourceOf(entry, fixed));
    initial.add(key);
    essential.add(key);
  }
  else if (existing && group.isPending) for (const item of entries) {
    const own = sourceOf(item).own;
    const known = options.find((option) => option.value === own);
    if (known) initial.add(addSource(torrentSource(item.id, own)));
  }
  else if (existing) for (const point of rows) {
    const { draft, path, hash, source } = rowSource(point);
    if (!path && hash) {
      const key = addSource(source);
      if (!draft?.hash) initial.add(key);
      if (editable.has(point.id) || draft?.hash) essential.add(key);
    }
  }
  const packs = useQueries({
    queries: [...sources].map(([key, path]) => ({
      queryKey: ['mapping-files', entry.titleKey, key], queryFn: () => api<QueuePackFiles>(path), gcTime: 0,
    })),
  });
  const keys = [...sources.keys()];
  // A row shows its matches at once, so the table waits for each torrent of the dialog and for the library.
  const loading = group.isPending || (existing && (candidates.isPending || library.isPending))
    || packs.some((pack, index) => initial.has(keys[index]!) && pack.isPending);
  const lists = new Map(keys.map((key, i) => {
    const files = packs[i]!.data?.files;
    return [key, { files, options: fileOptions(files ?? []) }];
  }));
  const proposed = (point: QueueMappingEpisode, key: string, name?: string) => {
    const files = lists.get(key)?.files;
    if (name) return files?.find((file) => file.rel === name) ?? files?.find((file) => file.originalName === name);
    return files?.find((file) => file.current?.some((cover) => sameEpisode(cover, point)))
      ?? (seasonChanged(point) ? undefined : files?.find((file) => file.proposal?.episodes.some((cover) => sameEpisode(cover, point))));
  };
  const movieList = lists.get(sourceOf(entry, fixed).key);
  const failed = group.error ?? library.error ?? seasonGroups.find((query) => query.error)?.error ?? manifests.find((query) => query.error)?.error
    ?? packs.find((pack, i) => essential.has(keys[i]!) && pack.error)?.error;
  const shown = error || (failed ? errorText(failed) : '');

  const change = (id: string, draft: Draft) => {
    setDrafts((state) => ({ ...state, [id]: draft }));
    setError('');
  };

  // Keep existing coverage when a file also contains episodes from another season.
  function changes(corrected: Map<string, EpisodeRef[]>): Change[] {
    if (!series) return movie ? [{ id: entry.id, source: sourceOf(entry, fixed).type, file: movie, ids: [entry.id] }] : [];
    const groups = new Map<string, Change & { covers: EpisodeRef[] }>();
    for (const point of rows) {
      const { draft, path, match, hash, source } = rowSource(point);
      const selected = editable.has(point.id) || (mapSeries && Boolean(draft?.hash || draft?.file));
      if (path || (!mapSeries && match) || (mapSeries && !selected)) continue;
      const file = draft?.file !== undefined
        ? lists.get(source.key)?.files?.find((file) => file.rel === draft.file?.rel)
        : mapSeries && source.path ? proposed(point, source.key, source.hash ? undefined : match?.file) : undefined;
      if (!file) continue;
      const key = JSON.stringify([source.key, file.rel]);
      const group = groups.get(key) ?? {
        id: point.id, source: source.type, file: file.rel, covers: [...((source.type === 'library' ? corrected.get(file.rel) : undefined) ?? file.current ?? [])], ids: [],
      };
      if (!group.covers.some((p) => p.season === point.season && p.number === point.number)) group.covers.push({ season: point.season, number: point.number });
      if (selected) {
        const explicitHash = source.hash ?? (mapSeries && !editable.has(point.id) ? hash : undefined);
        group.ids.push(point.id);
        if (explicitHash || group.ids.length === 1) group.id = point.id;
        if (explicitHash) group.hash = explicitHash;
      }
      groups.set(key, group);
    }
    return [...groups.values()].filter((group) => group.ids.length);
  }

  async function save() {
    if (submitting.current || invalidSeason) return;
    const corrected = new Map<string, EpisodeRef[]>();
    const confirmedIds: string[] = [];
    const coverage = (path: string) => corrected.get(path) ?? library.data?.files.find((file) => file.path === path)?.episodes ?? [];
    for (const row of rows) {
      const { id, season, number } = row;
      const { path: saved, draft } = rowSource(row);
      if (!existing || !saved || !row.torrent) continue;
      const path = draft?.path ?? saved;
      if (editable.has(id)) confirmedIds.push(id);
      else if (path === saved) continue;
      const point = { season, number };
      if (path !== saved) corrected.set(saved, coverage(saved).filter((ep) => !sameEpisode(ep, point)));
      corrected.set(path, [...coverage(path).filter((ep) => !sameEpisode(ep, point)), point]);
    }
    const posts = rejected ? [] : changes(corrected);
    const assignments = Object.entries(selections).flatMap(([id, draft]) => eligible.has(id) && draft?.file ? [{ id, ...draft }] : []);
    if (!mapSeries && !posts.length && !corrected.size) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const assigned = new Set([...confirmedIds, ...posts.flatMap((post) => post.ids), ...assignments.map(({ id }) => id)]);
      const edits = rows.filter((point) => seasonChanged(point) && (!rejected || eligible.has(point.id))).map((point) => ({
        season: point.season, number: point.number, releaseSeason: Number(seasons[point.id]),
        search: searchSeasons.includes(Number(seasons[point.id])) && !assigned.has(point.id) && !rowSource(point).match,
      }));
      if (edits.length) {
        await api(`/library/${entry.titleKey}`, { method: 'PATCH', body: { episodeSeasons: { revision: group.data!.numberingRevision, edits } } });
        await client.invalidateQueries({ queryKey: [`/library/${entry.titleKey}`] });
      }
      if (corrected.size) {
        const body = { titleKey: entry.titleKey, entries: [...corrected].map(([path, episodes]) => ({ path, episodes })), ids: confirmedIds };
        const preview = await api<{ version: string; counts: { blocked: number; review: number } }>('/mapping/preview', { method: 'POST', body });
        if (preview.counts.blocked || preview.counts.review) throw new ApiError(409, 'mapping_changed');
        await api('/mapping/apply', { method: 'POST', body: { ...body, version: preview.version } });
      }
      for (const post of posts) await apply(post);
      for (const [season, { id, torrents }] of releaseBatches(assignments)) {
        await api(`/queue/entries/${id}/releases/map`, { method: 'POST', body: { torrents } });
        setReleases((current) => Object.fromEntries(Object.entries(current).filter(([, draft]) => draft?.season !== season)));
      }
      onDone();
    } catch (err) {
      setError(errorText(err));
      if (series) void group.refetch();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const columns = [
    { label: t('Episodes'), width: '9rem' },
    ...(mapSeries ? [{ label: t('Season'), width: '8rem' }, { label: t('Torrent'), width: '22rem' }] : []),
    { label: t('Matches'), width: mapSeries ? '21rem' : undefined },
  ];

  const episodeRow = (point: QueueMappingEpisode) => {
    const pending = eligible.has(point.id);
    const season = (
      <SearchableDropdown key="season" label={t('Season')} hideLabel width="full" surface="table" allowCustom options={seasonOptions} emptyText={t('No options.')}
        disabled={busy || (Boolean(rejected) && !pending)} value={seasons[point.id] ?? String(point.releaseSeason)}
        onValueChange={(value) => setSeasons((state) => ({ ...state, [point.id]: value }))} />
    );
    if (rejected) {
      const draft = pending ? selections[point.id] : undefined;
      const manifest = draft ? manifestPath(draft.candidate) : '';
      const choices = rejectedBySeason.get(point.season) ?? [];
      const saved = point.match?.file ?? '';
      return {
        key: point.id,
        cells: [
          pointText(point), season,
          <SearchableDropdown
            key="torrent" label={t('Torrent')} hideLabel width="full" surface="table" value={manifest}
            placeholder={t('No torrent selected')} emptyText={t('No options.')} disabled={busy || !pending}
            options={choices.map((candidate) => ({ value: manifestPath(candidate), label: candidate.release.title }))}
            onValueChange={(value) => {
              if (manifest === value) return;
              const candidate = choices.find((candidate) => manifestPath(candidate) === value);
              setReleases((current) => ({ ...current, [point.id]: candidate ? { season: point.season, candidate, file: '' } : undefined }));
              setError('');
            }}
          />,
          <SearchableDropdown
            key={`release-file:${manifest}`} label={t('Matches')} hideLabel width="full" surface="table"
            placeholder={t('Unassigned')} emptyText={t('No options.')} disabled={busy || !draft}
            value={draft?.file ?? saved}
            options={draft ? [
              { value: '', label: t('Unassigned') },
              ...(releaseFiles.get(manifest) ?? []).map(({ path, sizeBytes }) => ({ value: path, label: sizeBytes === null ? path : `${path} (${formatBytes(sizeBytes)})` })),
            ] : saved ? [{ value: saved }] : []}
            onValueChange={(file) => {
              if (draft) setReleases((current) => ({ ...current, [point.id]: { ...draft, file } }));
              setError('');
            }}
          />,
        ],
      };
    }
    const { item, draft, torrent: verified, source, hash, match, path } = rowSource(point);
    const list = source.path ? lists.get(source.key) : undefined;
    const own = verified?.hash ?? '';
    const name = source.hash ? undefined : match?.file;
    const suggested = existing && !path && source.path ? proposed(point, source.key, name) : undefined;
    const canEdit = !match && !suggested && (editable.has(point.id) || fixedSource) && item?.status !== 'available';
    const shown = match?.file ?? item?.file?.name ?? (suggested ? suggested.originalName || suggested.rel : undefined) ?? '—';
    const fileValue = draft?.file !== undefined ? draft.file?.rel ?? '' : suggested?.rel ?? '';
    const selected = verified && !options.some((option) => option.value === own)
      ? [...options, { value: own, label: verified.name }] : options;
    const selectFile = (value: string | null) => change(point.id, { ...draft, file: list?.files?.find((file) => file.rel === value) ?? null });
    const alternatives = path && own ? libraryOptions?.filter((option) => option.hash === own) : undefined;
    const matches = mapSeries ? (
      <SearchableDropdown
        key={`file:${source.key}`} label={t('Matches')} hideLabel width="full" surface="table"
        placeholder={t('Unassigned')} emptyText={t('No options.')} disabled={busy}
        value={path ? draft?.path ?? path : fileValue}
        options={path ? alternatives ?? [{ value: path, label: match!.file }] : list?.options ?? []}
        onValueChange={path ? (next) => { if (next) change(point.id, { path: next }); } : selectFile}
      />
    ) : !canEdit ? readout(shown) : (
      <Dropdown key="file" width="full" reserve={false}
        value={draft?.file?.rel ?? ''} options={list?.options ?? []} onValueChange={selectFile} />
    );
    return {
      key: point.id,
      cells: [
        pointText(point),
        ...(mapSeries ? [season, (
          <SearchableDropdown
            key="torrent" label={t('Torrent')} hideLabel width="full" surface="table" value={hash}
            placeholder={t('No torrent selected')} emptyText={t('No options.')}
            options={selected}
            onValueChange={(next) => change(point.id, { hash: next === own ? undefined : next })}
          />
        )] : []),
        matches,
      ],
    };
  };

  const bySeason = new Map<number, QueueMappingEpisode[]>();
  if (mapSeries && !loading) for (const point of rows) {
    const points = bySeason.get(point.season);
    if (points) points.push(point);
    else bySeason.set(point.season, [point]);
  }
  const catalogSeasons = [...bySeason].sort(([a], [b]) => a - b);

  const title = groupName({ ...entry, season: null });
  const confirmTitle = addedSeasons.length ? t('Do you want to search for these new seasons?') : t('Apply this episode mapping?');
  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next && !busy) onClose(); }}
      title={mapSeries ? title : series && entry.season !== null ? `${title} / ${seasonName(entry.season)}` : entry.label}
      width={mapSeries ? 'xl' : 'lg'}
      actions={mapSeries ? (
        <Confirm label={t('Apply mapping')} title={confirmTitle}
          confirm={t('Yes')} onOpen={() => setSearchSeasons([])} onConfirm={() => void save()}
          disabled={busy || invalidSeason || !group.data || (existing && rows.some((point) => point.match?.path) && !library.data) || packs.some((pack, i) => essential.has(keys[i]!) && pack.isPending)}>
          {addedSeasons.length > 0 && (
            <div className="grid gap-2">
              {addedSeasons.map((season) => (
                <Checkbox key={season} label={t('Season {number}', { number: pad(season) })} checked={searchSeasons.includes(season)}
                  onCheckedChange={(on) => setSearchSeasons((current) => on ? [...current, season] : current.filter((n) => n !== season))} />
              ))}
            </div>
          )}
        </Confirm>
      ) : <Button disabled={busy || (!series && !movie)} pending={busy} onClick={() => void save()}>{t('Apply mapping')}</Button>}
    >
      {mapSeries ? (
        <Table
          aria-label={t('Map episodes')}
          loading={loading}
          columns={[{ label: t('Seasons'), hideLabel: true, width: '100%' }]}
          detailTone="open"
          rows={catalogSeasons.map(([season, points]) => {
            const open = expanded.includes(season);
            const id = `${detailId}-${season}`;
            const toggle = () => setExpanded((current) => current.includes(season)
              ? current.filter((number) => number !== season)
              : [...current, season]);
            return {
              key: String(season),
              onClick: toggle,
              cells: [
                <div className="flex items-center gap-2">
                  <Button variant="plain" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
                    {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                    {seasonName(season)}
                  </Button>
                  <Text variant="small">({points.length})</Text>
                </div>,
              ],
              detail: open && (
                <div id={id}>
                  <Table
                    aria-label={t('Episodes of season {number}', { number: season })}
                    columns={columns}
                    minWidth="60rem"
                    rows={points.toSorted((a, b) => a.number - b.number).map(episodeRow)}
                  />
                </div>
              ),
            };
          })}
        />
      ) : series ? (
        <Table
          aria-label={t('Map episodes')}
          loading={loading}
          columns={columns}
          rows={rows.map(episodeRow)}
        />
      ) : packs[0]?.isPending ? (
        <Spinner label={t('Loading files')} />
      ) : movieList?.files?.length ? (
        <Dropdown label={t('File')} value={movie} options={movieList.options} onValueChange={(value) => setMovie(value ?? '')} />
      ) : null}
      {!shown && packs.length > 0 && packs.every((pack) => pack.data?.files.length === 0) && <EmptyState>{t('No video file is available.')}</EmptyState>}
      {shown && <p role="alert">{shown}</p>}
    </Modal>
  );
}
