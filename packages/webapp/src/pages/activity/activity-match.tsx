import type { EpisodeRef, QueueEntryView, QueueGroupPage, QueueMatchPreview, QueuePackFiles } from '@ladarr/shared/types';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Details, Dropdown, EmptyState, Modal, Spinner, Table } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { formatBytes, groupName } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';

const errorText = (err: unknown) =>
  err instanceof ApiError && err.message === 'download_not_found'
    ? t('The download folder is not the same as configured as media.')
    : err instanceof ApiError && err.message === 'cover_not_in_download'
      ? t('The download does not hold one of the episodes.')
      : t('The request did not complete.');

const episodeText = (episodes: EpisodeRef[]) => episodes.map((item) => `S${String(item.season).padStart(2, '0')}E${String(item.number).padStart(2, '0')}`).join(', ');

type FileSource = QueuePackFiles['source'];

// A file choice authorizes only its episode. Existing file coverage stays intact.
export function MatchDialog({ entry, ids, label, fileSource, fixedSource, onDone }: { entry: QueueEntryView; ids?: string[]; label?: string; fileSource?: FileSource; fixedSource?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const series = entry.mediaType === 'tv';
  const targets = useQuery<QueueGroupPage>({
    queryKey: [`/queue/groups/${entry.titleKey}?season=${entry.season}`],
    enabled: open && series,
  });
  const rows = (series ? targets.data?.items ?? [entry] : [entry]).filter((item) =>
    item.status === 'stuck' && item.season === entry.season && (ids ?? [entry.id]).includes(item.id) &&
    item.actions.some((action) => action.action === (fixedSource ? 'use_existing' : 'match')),
  );
  const sourceOf = (item: QueueEntryView) =>
    fixedSource ? fileSource ?? 'library' : item.actions.find((action) => action.action === 'match')?.fileSource ?? (item.hasTorrent ? 'download' : 'library');
  const sourceKey = (item: QueueEntryView) =>
    sourceOf(item) === 'library' ? 'library' : item.actions.find((action) => action.action === 'match')?.source ?? item.id;
  const sources = new Map<string, QueueEntryView>();
  for (const item of rows) if (!sources.has(sourceKey(item))) sources.set(sourceKey(item), item);
  const anchors = [...sources.entries()];
  const files = useQueries({
    queries: anchors.map(([, item]) => {
      const path = `/queue/entries/${item.id}/files?source=${sourceOf(item)}`;
      return { queryKey: [path], queryFn: () => api<QueuePackFiles>(path), enabled: open, gcTime: 0 };
    }),
  });
  const packs = new Map(anchors.map(([key], index) => [key, files[index]?.data] as const));
  const packOf = (item: QueueEntryView) => packs.get(sourceKey(item));
  const loading = (series && targets.isPending) || files.some((query) => query.isPending);
  const failed = targets.error ?? files.find((query) => query.error)?.error;
  const shown = error || (failed ? errorText(failed) : '');
  const optionsOf = (item: QueueEntryView) => [
    { value: '', label: t('Unassigned') },
    ...(packOf(item)?.files.map((file) => ({ value: file.rel, label: `${file.rel} (${formatBytes(file.sizeBytes)})` })) ?? []),
  ];
  const change = (id: string, value: string | null) => {
    setChosen((current) => ({ ...current, [id]: value ?? '' }));
    setError('');
  };
  const changes = new Map<string, { entry: QueueEntryView; source: FileSource; file: string; covers: EpisodeRef[]; ids: string[] }>();
  for (const item of rows) {
    const pack = packOf(item);
    const file = pack?.files.find((file) => file.rel === chosen[item.id]);
    if (!file || !pack) continue;
    const key = JSON.stringify([sourceKey(item), file.rel]);
    const group = changes.get(key) ?? { entry: item, source: pack.source, file: file.rel, covers: [...(file.current ?? [])], ids: [] };
    group.ids.push(item.id);
    if (item.season !== null && !group.covers.some((point) => point.season === item.season && point.number === item.number)) {
      group.covers.push({ season: item.season, number: item.number! });
    }
    changes.set(key, group);
  }
  const selected = !series ? packOf(entry)?.files.find((file) => file.rel === chosen[entry.id]) : undefined;
  const text = t(label ?? (series ? 'Map episodes' : 'Select file'));

  async function save() {
    if (busy || !changes.size) return;
    setBusy(true);
    setError('');
    try {
      for (const group of changes.values()) {
        const path = `/queue/entries/${group.entry.id}/match`;
        const body = { source: group.source, file: group.file, ids: group.ids, ...(series ? { covers: group.covers } : {}) };
        const preview = await api<QueueMatchPreview>(path, { method: 'POST', body: { ...body, preview: true } });
        if (!preview.version || preview.effects.conflicts.length || preview.effects.lostAvailability.length) throw new ApiError(409, 'mapping_changed');
        await api(path, { method: 'POST', body: { ...body, version: preview.version } });
        setChosen((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !group.ids.includes(id))));
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
        <Button disabled={!changes.size || loading || busy} pending={busy} onClick={() => void save()}>{t('Apply mapping')}</Button>
      }
    >
      {open && <div className="grid grid-cols-[minmax(0,1fr)] justify-items-start gap-5 w-full">
        {shown && <Alert tone="danger">{shown}</Alert>}
        {series ? (
          <Table
            aria-label={t('Map episodes')}
            loading={loading}
            columns={[{ label: t('Episode'), hideLabel: true }]}
            rows={rows.map((item) => ({
              key: item.id,
              cells: [
                <Dropdown
                  label={item.label}
                  width="full"
                  reserve={false}
                  value={chosen[item.id] ?? ''}
                  disabled={busy || !packOf(item)?.files.length}
                  options={optionsOf(item)}
                  onValueChange={(value) => change(item.id, value)}
                />,
              ],
            }))}
          />
        ) : loading ? (
          <Spinner label={t('Loading files')} />
        ) : packOf(entry)?.files.length ? (
          <Dropdown label={t('File')} value={chosen[entry.id] ?? ''} disabled={busy} options={optionsOf(entry)} onValueChange={(value) => change(entry.id, value)} />
        ) : null}
        {!loading && !shown && !files.some((query) => query.data?.files.length) && (
          <EmptyState>{t('No video file is available.')}</EmptyState>
        )}
        {selected && (
          <Details items={[
            { label: t('Original name'), value: selected.originalName ?? selected.rel, wide: true },
            { label: t('Location'), value: selected.location ?? selected.rel, wide: true },
            ...(selected.source ? [{ label: t('Source download'), value: selected.source.hash, wide: true }] : []),
            { label: t('Current association'), value: selected.current?.length ? episodeText(selected.current) : t('Unassigned'), wide: true },
            ...(selected.metadata ? [
              ...(selected.metadata.title ? [{ label: t('Metadata title'), value: selected.metadata.title, wide: true }] : []),
              ...(selected.metadata.season !== null ? [{ label: t('Metadata season'), value: selected.metadata.season }] : []),
              ...(selected.metadata.episode !== null ? [{ label: t('Metadata episode'), value: selected.metadata.episode }] : []),
              ...(selected.metadata.durationSeconds !== null ? [{ label: t('Duration (seconds)'), value: selected.metadata.durationSeconds }] : []),
            ] : []),
            ...(selected.proposal ? [
              { label: t('Proposed episodes'), value: episodeText(selected.proposal.episodes), wide: true },
              { label: t('Proposal method'), value: selected.proposal.step },
              { label: t('Evidence'), value: selected.proposal.evidence, wide: true },
            ] : []),
            ...(selected.rejection ? [
              { label: t('Conflict'), value: selected.rejection.reason, wide: true },
              { label: t('Evidence'), value: selected.rejection.evidence, wide: true },
            ] : []),
          ]} />
        )}
      </div>}
    </Modal>
  );
}
