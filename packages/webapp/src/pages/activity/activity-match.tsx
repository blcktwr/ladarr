import type { AttachCandidates, EpisodeRef, QueueEntryView, QueueGroupPage, QueueMatchPreview, QueuePackFiles } from '@ladarr/shared/types';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Dropdown, EmptyState, Modal, Spinner, Table, TagInput, Text } from 'nebula';
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
const pointKey = (point: EpisodeRef) => `${point.season}:${point.number}`;

type FileSource = QueuePackFiles['source'];

// A file choice authorizes only its episode. Existing file coverage stays intact.
export function MatchDialog({ entry, ids, label, fileSource, fixedSource, onDone }: { entry: QueueEntryView; ids?: string[]; label?: string; fileSource?: FileSource; fixedSource?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [torrents, setTorrents] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const series = entry.mediaType === 'tv';
  const torrentColumn = series && !fixedSource;
  const affected = ids ?? [entry.id];
  const targets = useQuery<QueueGroupPage>({
    queryKey: [`/queue/groups/${entry.titleKey}?season=${entry.season}`],
    enabled: open && series,
  });
  const entries = series ? targets.data?.items ?? [entry] : [entry];
  const sourceOf = (item: QueueEntryView) =>
    fixedSource ? fileSource ?? 'library' : item.actions?.find((action) => action.action === 'match')?.fileSource ?? (item.hasTorrent ? 'download' : 'library');
  const ownTorrent = (item: QueueEntryView) => sourceOf(item) === 'download' ? item.actions?.find((action) => action.action === 'match')?.source ?? '' : '';
  const sourceKey = (item: QueueEntryView) =>
    sourceOf(item) === 'library' ? 'library' : ownTorrent(item) || item.id;
  // The episodes of the dialog, and the first target of each download, which asks for the files of that download.
  const rowsOfEntries = entries.filter((item) => affected.includes(item.id));
  const anchors = new Map<string, QueueEntryView>();
  for (const item of rowsOfEntries) if (!anchors.has(sourceKey(item))) anchors.set(sourceKey(item), item);
  if (!anchors.size) anchors.set(sourceKey(entry), entry);
  const candidates = useQuery<AttachCandidates>({
    queryKey: [`/queue/entries/${entry.id}/external?mapping=true`],
    enabled: open && torrentColumn,
    gcTime: 0,
  });
  const torrentOptions = (candidates.data?.torrents ?? []).map(({ hash, name }) => ({ value: hash, label: name }));
  const selectedTorrents = [...new Set(Object.values(torrents).filter(Boolean))];
  const fileQueries = new Map([...anchors].map(([key, item]) => [key, `/queue/entries/${item.id}/files?source=${sourceOf(item)}`]));
  for (const hash of selectedTorrents) fileQueries.set(`torrent:${hash}`, `/queue/entries/${entry.id}/files?source=download&hash=${hash}`);
  const packs = useQueries({
    queries: [...fileQueries.values()].map((path) => ({ queryKey: [path], queryFn: () => api<QueuePackFiles>(path), enabled: open, gcTime: 0 })),
  });
  const packsBySource = new Map([...fileQueries.keys()].map((key, index) => [key, packs[index]]));
  const packOf = (item: QueueEntryView) => packsBySource.get(sourceKey(item))?.data;
  const base = packs.find((query) => query.data)?.data;
  const targetsOfTitle = (base?.entries ?? entries).filter((target): target is EpisodeRef & { id: string; label: string } => target.season !== null && target.number !== null);
  const current = entry.season;
  const rows = targetsOfTitle.filter((target) => target.season === current).sort((a, b) => a.number - b.number);
  const loading = (series && targets.isPending) || [...anchors.keys()].some((key) => packsBySource.get(key)?.isPending);
  const failed = targets.error ?? selectedTorrents.map((hash) => packsBySource.get(`torrent:${hash}`)?.error).find(Boolean)
    ?? (torrentColumn && torrentOptions.length ? null : packs.find((query) => query.error)?.error);
  const shown = error || (failed ? errorText(failed) : '');
  // The target of an episode, and the download that the episode belongs to. An episode without a target takes the
  // first download of the dialog.
  const targetOf = (point: EpisodeRef) => entries.find((item) => item.id === `${entry.titleKey}:${point.season}x${point.number}`) ?? [...anchors.values()][0]!;
  const fileOf = (point: EpisodeRef) => chosen[pointKey(point)] ?? '';
  const selectedPack = (point: EpisodeRef, item: QueueEntryView) => {
    const hash = torrents[pointKey(point)];
    if (hash) return packsBySource.get(`torrent:${hash}`)?.data;
    if (hash === '' && ownTorrent(item)) return undefined;
    return packOf(item);
  };

  const change = (key: string, value: string | null) => {
    setChosen((state) => ({ ...state, [key]: value ?? '' }));
    setError('');
  };

  // The episodes of the season, in one request for each file. A file that holds several episodes names all of them.
  const groups = new Map<string, { entry: QueueEntryView; hash?: string; source: FileSource; file: string; covers: EpisodeRef[]; ids: string[] }>();
  for (const point of rows) {
    const file = fileOf(point);
    if (!file) continue;
    const item = targetOf(point);
    const hash = torrents[pointKey(point)] || undefined;
    const selected = selectedPack(point, item)?.files.find((found) => found.rel === file);
    if (!selected) continue;
    const source = hash ? 'download' : sourceOf(item);
    const key = JSON.stringify([hash ?? sourceKey(item), file]);
    const group = groups.get(key) ?? { entry: item, hash, source, file, covers: [...(selected.current ?? [])], ids: [] };
    const covered = group.covers.some((cover) => pointKey(cover) === pointKey(point));
    if (!covered) group.covers.push({ season: point.season, number: point.number });
    if ((!covered || hash) && affected.includes(point.id)) {
      group.hash ??= hash;
      if (group.hash && !group.ids.includes(group.entry.id)) group.entry = item;
      group.ids.push(point.id);
    }
    groups.set(key, group);
  }
  const changes = [...groups.values()].filter((group) => group.ids.length);
  const moviePack = packOf(entry);
  const movie = chosen[entry.id] ?? '';
  const count = series ? changes.length : movie ? 1 : 0;
  const text = t(label ?? (series ? 'Map episodes' : 'Select file'));

  async function save() {
    if (busy || !count) return;
    setBusy(true);
    setError('');
    try {
      const posts = series
        ? changes
        : [{ entry, hash: undefined, source: sourceOf(entry), file: movie, covers: undefined, ids: [entry.id] }];
      for (const post of posts) {
        const path = `/queue/entries/${post.entry.id}/match`;
        const body = { source: post.source, file: post.file, ids: post.ids, ...(post.covers ? { covers: post.covers } : {}), ...(post.hash ? { hash: post.hash } : {}) };
        const preview = await api<QueueMatchPreview>(path, { method: 'POST', body: { ...body, preview: true } });
        if (!preview.version || preview.effects.conflicts.length || preview.effects.lostAvailability.length) throw new ApiError(409, 'mapping_changed');
        await api(path, { method: 'POST', body: { ...body, version: preview.version } });
      }
      setOpen(false);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) {
          setChosen({});
          setTorrents({});
          setError('');
        }
        setOpen(next);
      }}
      title={series && entry.season !== null ? `${groupName({ ...entry, season: null })} / ${seasonName(entry.season)}` : entry.label}
      trigger={<Button>{text}</Button>}
      width="lg"
      actions={
        <>
          {shown && <p role="alert" className="text-error mr-auto">{shown}</p>}
          <Button disabled={busy || (!series && (!movie || loading))} pending={busy} onClick={() => void save()}>{t('Apply mapping')}</Button>
        </>
      }
    >
      {open && <div className="grid grid-cols-[minmax(0,1fr)] justify-items-start gap-5 w-full">
        {series ? (
          <Table
            aria-label={t('Map episodes')}
            loading={loading}
            minWidth={torrentColumn ? '30rem' : undefined}
            columns={[
              { label: t('Episodes'), ...(torrentColumn ? {} : { width: 'clamp(5rem, 20vw, 9rem)' }) },
              ...(torrentColumn ? [{ label: t('Torrent') }] : []),
              { label: t('Matches') },
            ]}
            rows={rows.map((point) => {
              const key = pointKey(point);
              const item = targetOf(point);
              const own = ownTorrent(item);
              const hash = torrents[key] ?? own;
              const options = own && !torrentOptions.some(({ value }) => value === own) ? [...torrentOptions, { value: own, label: item.release?.title ?? own }] : torrentOptions;
              const pack = selectedPack(point, item);
              const matched = entries.some((target) => target.id === point.id && target.status === 'available')
                || packOf(item)?.files.some((file) => file.current?.some((cover) => pointKey(cover) === key));
              return {
                key,
                cells: [
                  <Text key="episode">{pointText(point)}</Text>,
                  ...(torrentColumn ? [!matched && affected.includes(point.id) ? (
                    <TagInput
                      key={hash}
                      label={t('Torrent')}
                      hideLabel
                      width="full"
                      allowCustom={false}
                      emptyText={t('No options.')}
                      options={options}
                      value={hash ? [hash] : []}
                      onValueChange={(values) => {
                        const next = values.at(-1) ?? '';
                        setTorrents((state) => {
                          const choices = { ...state };
                          if (next === own) delete choices[key];
                          else choices[key] = next;
                          return choices;
                        });
                        change(key, '');
                      }}
                    />
                  ) : null] : []),
                  matched ? (
                    <Text key="match" variant="small">{t('Matched')}</Text>
                  ) : (
                    <Dropdown
                      key="match"
                      size="sm"
                      width="full"
                      reserve={false}
                      disabled={!pack}
                      value={fileOf(point)}
                      options={[
                        { value: '', label: t('Unassigned') },
                        ...(pack?.files ?? []).map((file) => ({ value: file.rel, label: `${file.rel} (${formatBytes(file.sizeBytes)})` })),
                      ]}
                      onValueChange={(value) => change(key, value)}
                    />
                  ),
                ],
              };
            })}
          />
        ) : loading ? (
          <Spinner label={t('Loading files')} />
        ) : (moviePack?.files.length ?? 0) > 0 ? (
          <Dropdown
            label={t('File')}
            value={movie}
            options={[
              { value: '', label: t('Unassigned') },
              ...(moviePack?.files ?? []).map((file) => ({ value: file.rel, label: `${file.rel} (${formatBytes(file.sizeBytes)})` })),
            ]}
            onValueChange={(value) => change(entry.id, value)}
          />
        ) : null}
        {!loading && !shown && !packs.some((query) => query.isPending || query.data?.files.length) && (
          <EmptyState>{t('No video file is available.')}</EmptyState>
        )}
      </div>}
    </Modal>
  );
}
