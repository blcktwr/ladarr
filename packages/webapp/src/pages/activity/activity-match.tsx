import type { EpisodeRef, QueueEntryView, QueueGroupPage, QueueMatchPreview, QueuePackFiles } from '@ladarr/shared/types';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, EmptyState, Modal, Spinner, Table, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { formatBytes, groupName, seasonName } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';

const errorText = (err: unknown) =>
  err instanceof ApiError && err.message === 'download_not_found'
    ? t('The download folder is not the same as configured as media.')
    : err instanceof ApiError && err.message === 'cover_not_in_download'
      ? t('The download does not hold one of the episodes.')
      : t('The request did not complete.');

const pad = (value: number) => String(value).padStart(2, '0');
const pointText = (point: EpisodeRef) => `S${pad(point.season)}E${pad(point.number)}`;
const pointKey = (point: EpisodeRef) => `${point.season}:${point.number}`;

type FileSource = QueuePackFiles['source'];

// A file choice authorizes only its episode. Existing file coverage stays intact. A series lists the episodes of one
// season, and each one takes the file of its download that holds it.
export function MatchDialog({ entry, ids, label, fileSource, fixedSource, onDone }: { entry: QueueEntryView; ids?: string[]; label?: string; fileSource?: FileSource; fixedSource?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [season, setSeason] = useState<number | null>(entry.season);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);
  const series = entry.mediaType === 'tv';
  const affected = ids ?? [entry.id];
  const targets = useQuery<QueueGroupPage>({
    queryKey: [`/queue/groups/${entry.titleKey}?season=${season ?? entry.season}`],
    enabled: open && series,
  });
  const entries = series ? targets.data?.items ?? [entry] : [entry];
  const sourceOf = (item: QueueEntryView) =>
    fixedSource ? fileSource ?? 'library' : item.actions?.find((action) => action.action === 'match')?.fileSource ?? (item.hasTorrent ? 'download' : 'library');
  const sourceKey = (item: QueueEntryView) =>
    sourceOf(item) === 'library' ? 'library' : item.actions?.find((action) => action.action === 'match')?.source ?? item.id;
  // The episodes of the dialog, and the first target of each download, which asks for the files of that download.
  const rowsOfEntries = entries.filter((item) => affected.includes(item.id));
  const anchors = new Map<string, QueueEntryView>();
  for (const item of rowsOfEntries) if (!anchors.has(sourceKey(item))) anchors.set(sourceKey(item), item);
  if (!anchors.size) anchors.set(sourceKey(entry), entry);
  const packs = useQueries({
    queries: [...anchors.values()].map((item) => {
      const path = `/queue/entries/${item.id}/files?source=${sourceOf(item)}`;
      return { queryKey: [path], queryFn: () => api<QueuePackFiles>(path), enabled: open, gcTime: 0 };
    }),
  });
  const keys = [...anchors.keys()];
  const packOf = (item: QueueEntryView) => packs[keys.indexOf(sourceKey(item))]?.data;
  const base = packs.find((query) => query.data)?.data;
  const files = base?.files ?? [];
  const targetsOfTitle = (base?.entries ?? []).filter((target): target is EpisodeRef & { id: string; label: string } => target.season !== null && target.number !== null);
  const seasons = [...new Set(targetsOfTitle.map((target) => target.season))].sort((a, b) => a - b);
  const current = season !== null && seasons.includes(season) ? season : seasons[0] ?? null;
  const rows = targetsOfTitle.filter((target) => target.season === current).sort((a, b) => a.number - b.number);
  const loading = (series && targets.isPending) || packs.some((query) => query.isPending);
  const failed = targets.error ?? packs.find((query) => query.error)?.error;
  const shown = error || (failed ? errorText(failed) : '');
  // The target of an episode, and the download that the episode belongs to. An episode without a target takes the
  // first download of the dialog.
  const targetOf = (point: EpisodeRef) => entries.find((item) => item.id === `${entry.titleKey}:${point.season}x${point.number}`) ?? [...anchors.values()][0]!;
  const fileOf = (point: EpisodeRef) => chosen[pointKey(point)] ?? '';
  const optionsOf = (point: EpisodeRef) => {
    const pack = packOf(targetOf(point));
    return [
      { value: '', label: t('Unassigned') },
      ...(pack?.files ?? []).map((file) => ({ value: file.rel, label: `${file.rel} (${formatBytes(file.sizeBytes)})` })),
    ];
  };

  // The dialog starts from the files that each episode has now.
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current || !base) return;
    seeded.current = true;
    const saved: Record<string, string> = {};
    for (const point of targetsOfTitle) {
      const pack = packOf(targetOf(point));
      const file = pack?.files.find((item) => item.current?.some((cover) => cover.season === point.season && cover.number === point.number));
      if (file) saved[pointKey(point)] = file.rel;
    }
    setChosen(saved);
  }, [open, base]);

  const change = (key: string, value: string | null) => {
    setChosen((state) => ({ ...state, [key]: value ?? '' }));
    setError('');
  };

  // The episodes of the season, in one request for each file. A file that holds several episodes names all of them.
  const groups = new Map<string, { entry: QueueEntryView; source: FileSource; file: string; covers: EpisodeRef[]; ids: string[] }>();
  for (const point of rows) {
    const file = fileOf(point);
    if (!file) continue;
    const item = targetOf(point);
    const source = sourceOf(item);
    const key = JSON.stringify([sourceKey(item), file]);
    // The episodes of another season that the file holds are not on this table, so the file keeps them.
    const kept = (packOf(item)?.files.find((found) => found.rel === file)?.current ?? []).filter((cover) => cover.season !== current);
    const group = groups.get(key) ?? { entry: item, source, file, covers: kept.map((cover) => ({ season: cover.season, number: cover.number })), ids: [] };
    group.covers.push({ season: point.season, number: point.number });
    if (affected.includes(`${entry.titleKey}:${point.season}x${point.number}`)) group.ids.push(`${entry.titleKey}:${point.season}x${point.number}`);
    groups.set(key, group);
  }
  // A file with no target of this dialog has nothing to link. A file that keeps the episodes that it has now is saved.
  const changes = [...groups.values()].filter((group) => {
    if (!group.ids.length) return false;
    const before = (packOf(group.entry)?.files.find((file) => file.rel === group.file)?.current ?? []).map(pointKey).sort();
    const after = group.covers.map(pointKey).sort();
    return before.join() !== after.join();
  });
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
        ? changes.map((group) => ({ entry: group.entry, source: group.source, file: group.file, covers: group.covers as EpisodeRef[] | undefined, ids: group.ids }))
        : [{ entry, source: sourceOf(entry), file: movie, covers: undefined, ids: [entry.id] }];
      for (const post of posts) {
        const path = `/queue/entries/${post.entry.id}/match`;
        const body = { source: post.source, file: post.file, ids: post.ids, ...(post.covers ? { covers: post.covers } : {}) };
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
          setError('');
        }
        setOpen(next);
      }}
      title={series ? groupName(entry) : entry.label}
      trigger={<Button>{text}</Button>}
      width="lg"
      actions={
        <Button disabled={!count || loading || busy} pending={busy} onClick={() => void save()}>{t('Apply mapping')}</Button>
      }
    >
      {open && <div className="grid grid-cols-[minmax(0,1fr)] justify-items-start gap-5 w-full">
        {shown && <Alert tone="danger">{shown}</Alert>}
        {series && seasons.length > 0 && (
          <Dropdown
            label={t('Season')}
            value={current === null ? '' : String(current)}
            options={seasons.map((number) => ({ value: String(number), label: seasonName(number) }))}
            onValueChange={(value) => setSeason(Number(value))}
          />
        )}
        {series ? (
          <Table
            aria-label={t('Map episodes')}
            loading={loading}
            columns={[
              { label: t('Episodes'), width: '5rem' },
              { label: t('Matches') },
            ]}
            rows={rows.map((point) => ({
              key: pointKey(point),
              cells: [
                <Text key="episode">{pointText(point)}</Text>,
                <Dropdown
                  key="match"
                  size="sm"
                  width="full"
                  reserve={false}
                  value={fileOf(point)}
                  disabled={busy || !(packOf(targetOf(point))?.files.length)}
                  options={optionsOf(point)}
                  onValueChange={(value) => change(pointKey(point), value)}
                />,
              ],
            }))}
          />
        ) : loading ? (
          <Spinner label={t('Loading files')} />
        ) : (moviePack?.files.length ?? 0) > 0 ? (
          <Dropdown
            label={t('File')}
            value={movie}
            disabled={busy}
            options={[
              { value: '', label: t('Unassigned') },
              ...(moviePack?.files ?? []).map((file) => ({ value: file.rel, label: `${file.rel} (${formatBytes(file.sizeBytes)})` })),
            ]}
            onValueChange={(value) => change(entry.id, value)}
          />
        ) : null}
        {!loading && !shown && files.length === 0 && (moviePack?.files.length ?? 0) === 0 && (
          <EmptyState>{t('No video file is available.')}</EmptyState>
        )}
      </div>}
    </Modal>
  );
}
