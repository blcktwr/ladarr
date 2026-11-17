import type { EpisodeRef, QueueEntryView, QueueGroupPage, QueueMatchPreview, QueuePackFiles } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button, Checkbox, Details, Dropdown, EmptyState, List, Panel, Row, Section, Spinner, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { formatBytes, stageLabel } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';

const errorText = (err: unknown) =>
  err instanceof ApiError && err.message === 'download_not_found'
    ? t('The download folder is not the same as configured as media.')
    : err instanceof ApiError && err.message === 'cover_not_in_download'
      ? t('The download does not hold one of the episodes.')
      : err instanceof ApiError && ['preview_changed', 'mapping_changed', 'mapping_stale', 'preview_required'].includes(err.message)
        ? t('The preview changed. Preview the changes again.')
        : t('The request did not complete.');

const episodeText = (episodes: EpisodeRef[]) => episodes.map((item) => `S${String(item.season).padStart(2, '0')}E${String(item.number).padStart(2, '0')}`).join(', ');

type FileSource = QueuePackFiles['source'];

// File coverage and authorization to continue are separate selections.
function MatchBody({ entry, ids, fileSource, fixedSource, onDone }: { entry: QueueEntryView; ids?: string[]; fileSource?: FileSource; fixedSource?: boolean; onDone: () => void }) {
  const [source, setSource] = useState<FileSource>(fileSource ?? (entry.hasTorrent ? 'download' : 'library'));
  const files = useQuery<QueuePackFiles>({ queryKey: [`/queue/entries/${entry.id}/files?source=${source}`], gcTime: 0 });
  const targets = useQuery<QueueGroupPage>({ queryKey: [`/queue/groups/${entry.titleKey}`], enabled: entry.mediaType === 'tv' });
  const pack = files.data;
  const [chosen, setChosen] = useState('');
  const [covers, setCovers] = useState<string[]>([entry.id]);
  const [authorized, setAuthorized] = useState<string[]>([entry.id]);
  const [preview, setPreview] = useState<QueueMatchPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const shown = error || (files.error ? errorText(files.error) : '');

  const episodes = pack?.entries.filter((item) => item.season !== null) ?? [];
  const selected = pack?.files.find((file) => file.rel === chosen);
  const download = entry.actions.find((item) => item.action === 'match' || item.action === 'use_existing')?.source;
  const siblings = targets.data?.items.filter((item) => item.status === 'stuck' && item.id !== entry.id && item.actions.some((action) => (action.action === 'match' || action.action === 'use_existing') && (source === 'library' || action.source === download))) ?? [];
  const coverage = episodes.filter((item) => covers.includes(item.id)).map((item) => ({ season: item.season!, number: item.number! }));
  const labelOf = (id: string) => pack?.entries.find((item) => item.id === id)?.label ?? targets.data?.items.find((item) => item.id === id)?.label ?? (id === entry.id ? entry.label : id);
  const effects = preview?.effects;
  const body = (extra: object = {}) => ({
    source,
    file: chosen,
    ...(entry.mediaType === 'tv' ? { covers: coverage } : {}),
    ids: authorized.filter((id) => entry.mediaType === 'movie' || covers.includes(id)),
    ...extra,
  });

  async function save() {
    if (!preview?.version) return;
    setBusy(true);
    try {
      await api(`/queue/entries/${entry.id}/match`, { method: 'POST', body: body({ source: preview.source, version: preview.version }) });
      onDone();
    } catch (err) {
      setPreview(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // The answer of a preview is for the selection that sent it. A new selection discards it.
  const selection = `${source}|${chosen}|${[...covers].sort().join(',')}|${[...authorized].sort().join(',')}`;
  const current = useRef(selection);
  current.current = selection;

  async function show() {
    const sent = selection;
    setPreview(null);
    setBusy(true);
    try {
      const data = await api<QueueMatchPreview>(`/queue/entries/${entry.id}/match`, { method: 'POST', body: body({ preview: true }) });
      if (current.current === sent) setPreview(data);
      setError('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={t('File for {label}', { label: entry.label })}
      action={
        <div className="flex flex-wrap justify-end gap-2 w-full">
          <Button disabled={!chosen || busy || !pack} pending={busy && !preview} onClick={() => void show()}>
            {t('Preview changes')}
          </Button>
          {preview && <Button disabled={!preview.version || busy || Boolean(effects?.conflicts.length)} pending={busy} onClick={() => void save()}>{t('Apply mapping')}</Button>}
        </div>
      }
    >
      {shown && <Alert tone="danger">{shown}</Alert>}
      <Dropdown
        label={t('Source')}
        value={source}
        disabled={fixedSource}
        options={(fixedSource ? [source] : pack?.sources ?? (entry.hasTorrent ? ['download', 'library'] : ['library'])).map((value) => ({ value, label: value === 'library' ? t('Library') : t('Download') }))}
        onValueChange={(value) => {
          if (value !== 'library' && value !== 'download') return;
          setSource(value);
          setChosen('');
          setCovers([]);
          setAuthorized([entry.id]);
          setPreview(null);
          setError('');
        }}
      />
      {!pack && !shown && <Spinner label={t('Loading files')} />}
      {pack && pack.files.length === 0 && <EmptyState>{t('No video file is available.')}</EmptyState>}
      {pack && pack.files.length > 0 && (
        <Dropdown
          label={t('File')}
          value={chosen || null}
          onValueChange={(value) => {
            setChosen(value ?? '');
            const file = pack.files.find((item) => item.rel === value);
            setCovers(file?.current?.length ? episodes.filter((item) => file.current!.some((cover) => cover.season === item.season && cover.number === item.number)).map((item) => item.id) : [entry.id]);
            setPreview(null);
          }}
          options={pack.files.map((file) => ({ value: file.rel, label: `${file.rel} (${formatBytes(file.sizeBytes)})` }))}
        />
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
      {pack && episodes.length > 0 && (
        <Section title={t('Episodes in this file')}>
          {episodes.map((item) => (
            <Checkbox
              key={item.id}
              label={item.label}
              checked={covers.includes(item.id)}
              onCheckedChange={(on) => {
                setCovers(on ? [...covers, item.id] : covers.filter((id) => id !== item.id));
                setPreview(null);
              }}
            />
          ))}
          {covers.length === 0 && <Text variant="small">{t('The file stays unassigned.')}</Text>}
        </Section>
      )}
      {entry.mediaType === 'tv' && (
        <Section title={t('Authorize continuation for')}>
          {[entry, ...siblings.sort((a, b) => Number(ids?.includes(b.id)) - Number(ids?.includes(a.id)))].map((item) => (
            <Checkbox key={item.id} label={t('Continue {label}', { label: item.label })} checked={authorized.includes(item.id)} onCheckedChange={(on) => {
              setAuthorized(on ? [...authorized, item.id] : authorized.filter((id) => id !== item.id));
              setPreview(null);
            }} />
          ))}
        </Section>
      )}
      {preview && (
        <Section title={t('Changes')}>
          <p>
            <strong>{preview.affected.length === 1 ? t('{file} goes to 1 target.', { file: preview.file }) : t('{file} goes to {n} targets.', { file: preview.file, n: preview.affected.length })}</strong>
          </p>
          <List>
            {preview.affected.map((item) => (
              <Row key={item.id}>
                {item.current ? t('{label}: now {current}', { label: item.label, current: item.current }) : item.label}
              </Row>
            ))}
          </List>
          {preview.replaces.length > 0 && (
            <p>
              {t('These targets lose {file}: {labels}.', { file: preview.file, labels: preview.replaces.map((item) => item.label).join(', ') })}
            </p>
          )}
          {effects?.lostAvailability.length ? <Text>{t('Episodes that lose availability: {episodes}.', { episodes: episodeText(effects.lostAvailability) })}</Text> : null}
          {effects?.continued.map((item) => <Text key={item.id}>{t('Continue at {stage}: {label}.', { stage: stageLabel(item.phase), label: labelOf(item.id) })}</Text>)}
          {effects?.staysBlocked.map((item) => <Text key={item.id}>{t('Stays blocked: {label}.', { label: labelOf(item.id) })} {t(item.code)}</Text>)}
          {effects && effects.conflicts.length > 0 && (
            <Section title={t('Conflicts')}>
              <List>
                {effects.conflicts.map((item) => (
                  <Row key={`${item.file}:${item.code}`}>
                    <div className="grid gap-1">
                      <Text>{item.file}</Text>
                      <Text variant="small">{item.ids.map(labelOf).join(', ')}</Text>
                      <Text>{t(item.code)}</Text>
                    </div>
                  </Row>
                ))}
              </List>
            </Section>
          )}
          {!effects && preview.retries.length > 0 && <Text>{t('Continue at import: {labels}.', { labels: preview.retries.map((item) => item.label).join(', ') })}</Text>}
        </Section>
      )}
    </Section>
  );
}

export function MatchDialog({ entry, ids, label, fileSource, fixedSource, onDone }: { entry: QueueEntryView; ids?: string[]; label?: string; fileSource?: FileSource; fixedSource?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const text = t(label ?? (entry.mediaType === 'movie' ? 'Select file' : 'Map episodes'));
  return (
    <Panel open={open} onOpenChange={setOpen} label={text} title={entry.label} trigger={<Button>{text}</Button>} size="lg">
      {open && <MatchBody entry={entry} ids={ids} fileSource={fileSource} fixedSource={fixedSource} onDone={() => { setOpen(false); onDone(); }} />}
    </Panel>
  );
}
