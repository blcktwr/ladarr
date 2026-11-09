import type { QueueEntryView, QueueMatchPreview, QueuePackFiles } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button, Checkbox, Dropdown, EmptyState, List, Panel, Row, Section, Spinner } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';

const errorText = (err: unknown) =>
  err instanceof ApiError && err.message === 'download_not_found'
    ? t('The download folder is not the same as configured as media.')
    : err instanceof ApiError && err.message === 'cover_not_in_download'
      ? t('The download does not hold one of the episodes.')
      : t('The request did not complete.');

// Matches one file of a download to the target, or to several episodes. The user sees every change before it starts.
function MatchBody({ entry, onDone }: { entry: QueueEntryView; onDone: () => void }) {
  const files = useQuery<QueuePackFiles>({ queryKey: [`/queue/entries/${entry.id}/files`] });
  const pack = files.data;
  const [chosen, setChosen] = useState('');
  // The ids of the episodes that the file covers. The target that the user opened is always one of them.
  const [covers, setCovers] = useState<string[]>([entry.id]);
  const [preview, setPreview] = useState<QueueMatchPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const shown = error || (files.error ? errorText(files.error) : '');

  const episodes = pack?.entries.filter((item) => item.season !== null) ?? [];
  const body = (extra: object = {}) => ({
    file: chosen,
    ...(episodes.length ? { covers: episodes.filter((item) => covers.includes(item.id)).map((item) => ({ season: item.season, number: item.number })) } : {}),
    ...extra,
  });
  // A download with one target has no other target that the match can change, so it needs no preview.
  const single = (pack?.entries.length ?? 0) <= 1;

  async function save() {
    setBusy(true);
    try {
      await api(`/queue/entries/${entry.id}/match`, { method: 'POST', body: body() });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // The answer of a preview is for the selection that sent it. A new selection discards it.
  const selection = `${chosen}|${[...covers].sort().join(',')}`;
  const current = useRef(selection);
  current.current = selection;

  async function show() {
    const sent = selection;
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
      title={t('Match a file to {label}', { label: entry.label })}
      actions={
        single || preview ? (
          <Button disabled={!chosen || busy} onClick={() => void save()}>
            {t('Use this file')}
          </Button>
        ) : (
          <Button disabled={!chosen || busy} onClick={() => void show()}>
            {t('Show the changes')}
          </Button>
        )
      }
    >
      {shown && <Alert tone="danger">{shown}</Alert>}
      {!pack && !shown && <Spinner label={t('Loading files')} />}
      {pack && pack.files.length === 0 && <EmptyState>{t('The download has no video file.')}</EmptyState>}
      {pack && pack.files.length > 0 && (
        <Dropdown
          label={t('File')}
          value={chosen || null}
          onValueChange={(value) => {
            setChosen(value ?? '');
            setPreview(null);
          }}
          options={pack.files.map((file) => ({ value: file.rel, label: `${file.rel} (${formatBytes(file.sizeBytes)})` }))}
        />
      )}
      {pack && episodes.length > 1 && (
        <Section title={t('Episodes in this file')}>
          {episodes.map((item) => (
            <Checkbox
              key={item.id}
              label={item.label}
              disabled={item.id === entry.id}
              checked={covers.includes(item.id)}
              onCheckedChange={(on) => {
                setCovers(on ? [...covers, item.id] : covers.filter((id) => id !== item.id));
                setPreview(null);
              }}
            />
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
          {preview.retries.length > 0 && <p>{preview.retries.length === 1 ? t('The import starts again for 1 target.') : t('The import starts again for {n} targets.', { n: preview.retries.length })}</p>}
        </Section>
      )}
    </Section>
  );
}

// Nebula has no dialog that a page opens from its own state. A side panel opens from its own button, and it closes when the button leaves the page.
export function MatchDialog({ entry, onDone }: { entry: QueueEntryView; onDone: () => void }) {
  return (
    <Panel label={t('Match file to {label}', { label: entry.label })} trigger={<Button>{t('Match file')}</Button>}>
      <MatchBody entry={entry} onDone={onDone} />
    </Panel>
  );
}
