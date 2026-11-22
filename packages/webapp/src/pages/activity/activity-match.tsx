import type { AttachCandidates, EpisodeRef, FileRow, QueueEntryView, QueueGroupPage, QueueMappingEpisode, QueueMatchPreview, QueuePackFiles } from '@ladarr/shared/types';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Dropdown, EmptyState, Modal, SearchableDropdown, Spinner, Table } from 'nebula';
import { Confirm } from '../../components/confirm.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { formatBytes, groupName, seasonName } from '../../lib/format.ts';
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
          : t('The request did not complete.');

const pad = (value: number) => String(value).padStart(2, '0');
const pointText = (point: EpisodeRef) => `S${pad(point.season)}E${pad(point.number)}`;
const sameEpisode = (a: EpisodeRef, b: EpisodeRef) => a.season === b.season && a.number === b.number;
type FileSource = QueuePackFiles['source'];
type PackFile = QueuePackFiles['files'][number];
type Draft = { hash?: string; file?: PackFile | null; path?: string };
type Change = { id: string; source: FileSource; hash?: string; file: string; ids: string[]; covers?: EpisodeRef[] };
export type MatchRequest = { entry: QueueEntryView; ids: string[]; entries: QueueEntryView[]; fileSource?: FileSource; fixedSource: boolean };

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

export function MatchDialog({ entry, ids, entries, fileSource, fixedSource, onClose, onDone }: MatchRequest & { onClose: () => void; onDone: () => void }) {
  const series = entry.mediaType === 'tv';
  const mapSeries = series && !fixedSource;
  const fixed = fixedSource ? fileSource ?? 'library' : undefined;
  const [season, setSeason] = useState(entry.season);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [movie, setMovie] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState('');
  const [discarded, setDiscarded] = useState<Set<string>>(new Set());
  const client = useQueryClient();
  const group = useQuery<QueueGroupPage>({
    queryKey: [`/queue/groups/${entry.titleKey}?mapping=true${mapSeries ? '' : `&season=${entry.season}`}`],
    enabled: series,
    gcTime: 0,
  });
  const candidates = useQuery<AttachCandidates>({
    queryKey: [`/queue/entries/${entry.id}/external?mapping=true`],
    enabled: mapSeries,
    gcTime: 0,
  });
  const options = (candidates.data?.torrents ?? []).map(({ hash, name }) => ({ value: hash, label: name }));
  const items = new Map(group.data?.items.map((item) => [item.id, item]));
  const editable = new Set(mapSeries ? group.data?.group.actions.filter((action) => action.action === 'match').flatMap((action) => action.ids) : ids);
  const episodes = group.data?.mapping ?? [];
  const library = useQuery<{ files: FileRow[] }>({
    queryKey: [`/library/${entry.titleKey}/files`],
    enabled: mapSeries,
    gcTime: 0,
  });
  const matchesByPath = new Map(episodes.flatMap(({ match, torrent }) => match?.path && torrent ? [[match.path, { label: match.file, hash: torrent.hash }] as const] : []));
  const libraryOptions = library.data?.files.flatMap((file) => {
    const match = matchesByPath.get(file.path);
    return !file.missing && match ? [{ value: file.path, ...match }] : [];
  });
  const rows = episodes.filter((point) => point.season === season);
  const seasons = [...new Set(episodes.length ? episodes.map((point) => point.season) : season === null ? [] : [season])];
  const sources = new Map<string, string>();
  const initial = new Set<string>();
  const essential = new Set<string>();
  const rowSource = (point: QueueMappingEpisode) => {
    const dropped = discarded.has(point.id);
    const item = dropped ? undefined : items.get(point.id);
    const draft = drafts[point.id];
    const torrent = dropped ? null : point.torrent;
    const match = dropped ? null : point.match;
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
  else if (group.isPending) for (const item of entries) {
    const own = sourceOf(item).own;
    const known = options.find((option) => option.value === own);
    if (known) initial.add(addSource(torrentSource(item.id, own)));
  }
  else for (const point of rows) {
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
  const loading = group.isPending || (mapSeries && (candidates.isPending || library.isPending))
    || packs.some((pack, index) => initial.has(keys[index]!) && pack.isPending);
  const lists = new Map(keys.map((key, i) => {
    const files = packs[i]!.data?.files;
    return [key, { files, options: fileOptions(files ?? []) }];
  }));
  const proposed = (point: EpisodeRef, key: string, name?: string) => {
    const files = lists.get(key)?.files;
    if (name) return files?.find((file) => file.rel === name) ?? files?.find((file) => file.originalName === name);
    return files?.find((file) => file.current?.some((cover) => sameEpisode(cover, point)))
      ?? files?.find((file) => file.proposal?.episodes.some((cover) => sameEpisode(cover, point)));
  };
  const movieList = lists.get(sourceOf(entry, fixed).key);
  const failed = group.error ?? library.error ?? packs.find((pack, i) => essential.has(keys[i]!) && pack.error)?.error;
  const shown = error || (failed ? errorText(failed) : '');

  const change = (id: string, draft: Draft) => {
    setDrafts((state) => ({ ...state, [id]: draft }));
    setError('');
  };

  // The episode leaves the series: it is unmonitored, it has no file, and its target leaves the queue.
  async function discard(point: QueueMappingEpisode) {
    if (busy || discarding) return;
    setDiscarding(point.id);
    setError('');
    try {
      await api(`/library/${entry.titleKey}/episodes/${point.season}/${point.number}`, { method: 'DELETE' });
      setDrafts((state) => {
        const next = { ...state };
        delete next[point.id];
        return next;
      });
      setDiscarded((state) => new Set(state).add(point.id));
      await Promise.all([group.refetch(), client.invalidateQueries({ queryKey: [`/library/${entry.titleKey}/files`] })]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDiscarding('');
    }
  }

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
    if (busy) return;
    const corrected = new Map<string, EpisodeRef[]>();
    const confirmedIds: string[] = [];
    const coverage = (path: string) => corrected.get(path) ?? library.data?.files.find((file) => file.path === path)?.episodes ?? [];
    for (const row of rows) {
      const { id, season, number } = row;
      const { path: saved, draft } = rowSource(row);
      if (!mapSeries || !saved) continue;
      const path = draft?.path ?? saved;
      if (editable.has(id)) confirmedIds.push(id);
      else if (path === saved) continue;
      const point = { season, number };
      if (path !== saved) corrected.set(saved, coverage(saved).filter((ep) => !sameEpisode(ep, point)));
      corrected.set(path, [...coverage(path).filter((ep) => !sameEpisode(ep, point)), point]);
    }
    const posts = changes(corrected);
    if (!mapSeries && !posts.length && !corrected.size) return;
    setBusy(true);
    setError('');
    try {
      if (corrected.size) {
        const body = { titleKey: entry.titleKey, entries: [...corrected].map(([path, episodes]) => ({ path, episodes })), ids: confirmedIds };
        const preview = await api<{ version: string; counts: { blocked: number; review: number } }>('/mapping/preview', { method: 'POST', body });
        if (preview.counts.blocked || preview.counts.review) throw new ApiError(409, 'mapping_changed');
        await api('/mapping/apply', { method: 'POST', body: { ...body, version: preview.version } });
      }
      for (const post of posts) await apply(post);
      const remaining = Object.fromEntries(episodes.filter((point) => point.season !== season && drafts[point.id]).map(({ id }) => [id, drafts[id]!]));
      if (Object.keys(remaining).length) {
        setDrafts(remaining);
        await Promise.all([group.refetch(), client.invalidateQueries({ queryKey: ['mapping-files', entry.titleKey] }), client.invalidateQueries({ queryKey: [`/library/${entry.titleKey}/files`] })]);
      } else onDone();
    } catch (err) {
      setError(errorText(err));
      if (series) void group.refetch();
    } finally {
      setBusy(false);
    }
  }

  const title = groupName({ ...entry, season: null });
  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next && !busy) onClose(); }}
      title={mapSeries ? title : series && season !== null ? `${title} / ${seasonName(season)}` : entry.label}
      width={mapSeries ? 'xl' : 'lg'}
      actions={
        <>
          {mapSeries && (
            <div className="mr-auto min-w-0 max-w-40 flex-1">
              <Dropdown
                label={t('Season')} hideLabel width="full" reserve={false}
                value={String(season)} options={seasons.map((n) => ({ value: String(n), label: seasonName(n) }))}
                onValueChange={(next) => { if (next !== null) setSeason(Number(next)); }}
              />
            </div>
          )}
          {mapSeries ? (
            <Confirm label={t('Apply mapping')} title={t('Does every episode in season {season} match the correct file?', { season: season! })}
              confirm={t('Yes')} onConfirm={() => void save()}
              disabled={busy || !group.data || (rows.some((point) => point.match?.path) && !library.data) || packs.some((pack, i) => essential.has(keys[i]!) && pack.isPending)} />
          ) : <Button disabled={busy || (!series && !movie)} pending={busy} onClick={() => void save()}>{t('Apply mapping')}</Button>}
        </>
      }
    >
      {series ? (
        <Table
          aria-label={t('Map episodes')}
          loading={loading}
          minWidth={mapSeries ? '52rem' : undefined}
          columns={[
            { label: t('Episodes'), width: '9rem' },
            ...(mapSeries ? [{ label: t('Torrent'), width: '22rem' }] : []),
            { label: t('Matches'), width: mapSeries ? '21rem' : undefined },
          ]}
          rows={rows.map((point) => {
            const dropped = discarded.has(point.id);
            const { item, draft, torrent: verified, source, hash, match, path } = rowSource(point);
            const list = source.path ? lists.get(source.key) : undefined;
            const own = verified?.hash ?? '';
            const name = source.hash ? undefined : match?.file;
            const suggested = mapSeries && !path && source.path ? proposed(point, source.key, name) : undefined;
            const canEdit = !match && !suggested && (editable.has(point.id) || fixedSource) && item?.status !== 'available';
            const shown = match?.file ?? item?.file?.name ?? (suggested ? suggested.originalName || suggested.rel : undefined) ?? '—';
            const fileValue = draft?.file !== undefined ? draft.file?.rel ?? '' : suggested?.rel ?? '';
            const selected = verified && !options.some((option) => option.value === own)
              ? [...options, { value: own, label: verified.name }] : options;
            const selectFile = (value: string | null) => change(point.id, { ...draft, file: list?.files?.find((file) => file.rel === value) ?? null });
            const matches = mapSeries ? (
              <SearchableDropdown
                key={`file:${source.key}`} label={t('Matches')} hideLabel width="full"
                placeholder={t('Unassigned')} emptyText={t('No options.')}
                value={path ? draft?.path ?? path : fileValue}
                options={path ? libraryOptions?.filter((option) => option.hash === own) ?? [{ value: path, label: match!.file }] : list?.options ?? []}
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
                ...(mapSeries ? [(
                  <SearchableDropdown
                    key="torrent" label={t('Torrent')} hideLabel width="full" value={hash}
                    placeholder={t('No torrent selected')} emptyText={t('No options.')}
                    options={selected}
                    onValueChange={(next) => change(point.id, { hash: next === own ? undefined : next })}
                  />
                )] : []),
                <div key="match" className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">{matches}</div>
                  <Button variant="ghost-danger" iconOnly
                    aria-label={t('Discard episode {episode}', { episode: pointText(point) })}
                    pending={discarding === point.id} disabled={busy || dropped} onClick={() => void discard(point)}>
                    {discarding === point.id ? null : <Trash2 />}
                  </Button>
                </div>,
              ],
            };
          })}
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
