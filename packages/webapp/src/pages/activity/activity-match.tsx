import type { AttachCandidates, EpisodeRef, QueueEntryView, QueueGroupPage, QueueMatchPreview, QueuePackFiles } from '@ladarr/shared/types';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Dropdown, EmptyState, Modal, SearchableDropdown, Spinner, Table } from 'nebula';
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
type FileSource = QueuePackFiles['source'];
type PackFile = QueuePackFiles['files'][number];
type Draft = { hash?: string; file?: PackFile };
type Change = { id: string; source: FileSource; hash?: string; file: string; ids: string[]; covers?: EpisodeRef[] };
export type MatchRequest = { entry: QueueEntryView; ids: string[]; fileSource?: FileSource; fixedSource: boolean };

const fileOptions = (files: PackFile[]) => [
  { value: '', label: t('Unassigned') },
  ...files.map((file) => ({ value: file.rel, label: `${file.rel} (${formatBytes(file.sizeBytes)})` })),
];

function sourceOf(item: QueueEntryView, hash?: string, fixed?: FileSource) {
  const action = item.actions.find((action) => action.action === 'match');
  const source = fixed ?? action?.fileSource ?? (item.hasTorrent ? 'download' : 'library');
  const own = source === 'download' ? action?.source ?? item.transfer?.hash ?? item.release?.title ?? '' : '';
  const selected = hash && hash !== own ? hash : undefined;
  const type = selected ? 'download' : source;
  const key = selected || own || (type === 'library' ? 'library' : item.id);
  const path = `/queue/entries/${item.id}/files?source=${type}${selected ? `&hash=${selected}` : ''}`;
  return { own, hash: selected, type, key, path: hash === '' && own ? null : path };
}

async function apply({ id, ...body }: Change) {
  const path = `/queue/entries/${id}/match`;
  const preview = await api<QueueMatchPreview>(path, { method: 'POST', body: { ...body, preview: true } });
  if (!preview.version || preview.effects.conflicts.length || preview.effects.lostAvailability.length) throw new ApiError(409, 'mapping_changed');
  await api(path, { method: 'POST', body: { ...body, version: preview.version } });
}

const readout = (text: string) => <div className="truncate" title={text}>{text}</div>;

export function MatchDialog({ entry, ids, fileSource, fixedSource, onClose, onDone }: MatchRequest & { onClose: () => void; onDone: () => void }) {
  const series = entry.mediaType === 'tv';
  const mapSeries = series && !fixedSource;
  const fixed = fixedSource ? fileSource ?? 'library' : undefined;
  const [season, setSeason] = useState(entry.season);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [movie, setMovie] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
  const rows = episodes.filter((point) => point.season === season);
  const seasons = [...new Set(episodes.length ? episodes.map((point) => point.season) : season === null ? [] : [season])];
  const sources = new Map<string, string>();
  // A pack that only fills the Matches of a row that a person can not edit is a reading: its failure is not an answer.
  const quiet = new Set<string>();
  const essential = new Set<string>();
  const addSource = (item: QueueEntryView, draft?: Draft) => {
    const { key, path } = sourceOf(item, draft?.hash, fixed);
    if (path && !sources.has(key)) sources.set(key, path);
    return key;
  };
  if (!series || fixedSource) essential.add(addSource(entry));
  else for (const point of episodes) {
    if (point.season !== season && !drafts[point.id]?.file) continue;
    const item = items.get(point.id);
    const edit = editable.has(point.id);
    // The pack of a season names the file of each episode. A row that is not editable shows that file too.
    if (item && !point.match && (edit || (point.season === season && item.hasTorrent))) {
      const key = addSource(item, edit ? drafts[point.id] : undefined);
      if (edit) essential.add(key);
      else quiet.add(key);
    }
  }
  const packs = useQueries({
    queries: [...sources].map(([key, path]) => ({
      queryKey: ['mapping-files', entry.titleKey, key], queryFn: () => api<QueuePackFiles>(path), gcTime: 0,
    })),
  });
  const keys = [...sources.keys()];
  const lists = new Map(keys.map((key, i) => {
    const files = packs[i]!.data?.files;
    return [key, { files, options: fileOptions(files ?? []) }];
  }));
  const covers = (point: EpisodeRef, file: PackFile) =>
    file.current?.some((cover) => cover.season === point.season && cover.number === point.number) ||
    file.proposal?.episodes.some((cover) => cover.season === point.season && cover.number === point.number);
  // The file that the matcher of the server gives to the episode, from the names and the metadata of the pack.
  const proposed = (point: EpisodeRef, key: string) => lists.get(key)?.files?.find((file) => covers(point, file));
  const movieList = lists.get(sourceOf(entry, undefined, fixed).key);
  const failed = group.error ?? packs.find((pack, i) => (!quiet.has(keys[i]!) || essential.has(keys[i]!)) && pack.error)?.error;
  const shown = error || (failed ? errorText(failed) : '');

  const change = (id: string, draft: Draft) => {
    setDrafts((state) => ({ ...state, [id]: draft }));
    setError('');
  };

  // Group the choices from every season by source and file. Keep the episodes that the file already covers.
  function changes(): Change[] {
    if (!series) return movie ? [{ id: entry.id, source: sourceOf(entry, undefined, fixed).type, file: movie, ids: [entry.id] }] : [];
    const groups = new Map<string, Change & { covers: EpisodeRef[] }>();
    for (const point of episodes) {
      const draft = drafts[point.id];
      if (point.match || (mapSeries && !editable.has(point.id))) continue;
      const item = items.get(point.id) ?? entry;
      const source = sourceOf(item, draft?.hash, fixed);
      const suggested = mapSeries && point.season === season && !draft?.file ? proposed(point, source.key) : undefined;
      const file = draft?.file ?? suggested;
      if (!file) continue;
      const key = JSON.stringify([source.key, file.rel]);
      const group = groups.get(key) ?? {
        id: item.id, source: source.type, file: file.rel, covers: [...(file.current ?? [])], ids: [],
      };
      if (!group.covers.some((p) => p.season === point.season && p.number === point.number)) group.covers.push({ season: point.season, number: point.number });
      if (editable.has(point.id)) {
        group.ids.push(point.id);
        if (source.hash || group.ids.length === 1) group.id = item.id;
        if (source.hash) group.hash = source.hash;
      }
      groups.set(key, group);
    }
    return [...groups.values()].filter((group) => group.ids.length);
  }

  async function save() {
    if (busy) return;
    const posts = changes();
    if (!posts.length) return;
    setBusy(true);
    setError('');
    try {
      for (const post of posts) await apply(post);
      onDone();
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
      width="lg"
      actions={
        <>
          {mapSeries && (
            <div className="mr-auto min-w-0 max-w-40 flex-1">
              <Dropdown
                label={t('Season')} hideLabel width="full" reserve={false} disabled={busy}
                value={String(season)} options={seasons.map((n) => ({ value: String(n), label: seasonName(n) }))}
                onValueChange={(next) => { if (next !== null) setSeason(Number(next)); }}
              />
            </div>
          )}
          <Button disabled={busy || (!series && !movie)} pending={busy} onClick={() => void save()}>{t('Apply mapping')}</Button>
        </>
      }
    >
      {series ? (
        <Table
          aria-label={t('Map episodes')}
          loading={group.isPending}
          minWidth={mapSeries ? '52rem' : undefined}
          columns={[
            { label: t('Episodes'), width: '9rem' },
            ...(mapSeries ? [{ label: t('Torrent'), width: '22rem' }] : []),
            { label: t('Matches'), width: mapSeries ? '21rem' : undefined },
          ]}
          rows={rows.map((point) => {
            const item = items.get(point.id);
            const draft = drafts[point.id];
            const source = sourceOf(item ?? entry, draft?.hash, fixed);
            const list = source.path ? lists.get(source.key) : undefined;
            const hash = draft?.hash ?? source.own;
            // What the matcher found is a match: it shows as text. Only what it did not find offers the selectors.
            const suggested = !point.match && mapSeries ? proposed(point, source.key) : undefined;
            const canEdit = !point.match && !suggested && (editable.has(point.id) || fixedSource) && item?.status !== 'available';
            const shown = point.match?.file ?? item?.file?.name ?? (suggested ? suggested.originalName || suggested.rel : undefined) ?? '—';
            const torrentName = (draft?.hash ? options.find((option) => option.value === draft.hash)?.label ?? draft.hash : undefined)
              ?? options.find((option) => option.value === point.match?.hash)?.label ?? point.match?.torrent ?? point.match?.hash
              ?? (!point.match && (item?.hasTorrent || source.own) ? item?.release?.title ?? options.find((option) => option.value === source.own)?.label ?? source.own : null) ?? '—';
            const selectFile = (value: string | null) => change(point.id, { ...draft, file: list?.files?.find((file) => file.rel === value) });
            return {
              key: point.id,
              cells: [
                pointText(point),
                ...(mapSeries ? [canEdit ? (
                  <SearchableDropdown
                    key="torrent" label={t('Torrent')} hideLabel width="full" value={hash}
                    disabled={busy} emptyText={t('No options.')}
                    options={source.own && !options.some((option) => option.value === source.own)
                      ? [...options, { value: source.own, label: item?.release?.title ?? source.own }] : options}
                    onValueChange={(next) => change(point.id, { hash: next === source.own ? undefined : next })}
                  />
                ) : readout(torrentName)] : []),
                !canEdit ? readout(shown) : mapSeries ? (
                  <SearchableDropdown
                    key={`file:${source.key}`} label={t('Matches')} hideLabel width="full"
                    placeholder={t('Unassigned')} emptyText={t('No options.')} disabled={busy || !list?.files}
                    value={draft?.file?.rel ?? ''} options={list?.options ?? []}
                    onValueChange={selectFile}
                  />
                ) : (
                  <Dropdown key="file" width="full" reserve={false} disabled={busy || !list?.files}
                    value={draft?.file?.rel ?? ''} options={list?.options ?? []} onValueChange={selectFile} />
                ),
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
