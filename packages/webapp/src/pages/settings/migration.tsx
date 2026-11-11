import type { MigrationBackup, MigrationPreview, MigrationProgress } from '@ladarr/shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, upload } from '../../lib/api.ts';
import { Button, Details, FileField, Progress as ProgressBar, Section, Spinner, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { ModalActions } from '../../components/modal-actions.tsx';
import { describeError } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { useLive } from '../../lib/live.ts';

function describeSourceError(err: unknown) {
  const message = describeError(err);
  const detail = err instanceof ApiError && typeof err.body.detail === 'string' ? ` (${err.body.detail})` : '';
  return `${message}${detail}`;
}

function ImportProgress({ progress }: { progress?: MigrationProgress }) {
  if (!progress) return <Spinner label={t('Loading')} />;
  if (progress.pending === 0) return null;
  const done = progress.imported + progress.matched + progress.failed;
  return (
    <div className="flex items-center gap-3">
      <Spinner label={t('Importing')} />
      <p>{t('Importing {done}/{total}', { done, total: done + progress.pending })}</p>
    </div>
  );
}

export function Migration({ onFinish, onClose, embedded = false }: { onFinish?: () => void; onClose?: () => void; embedded?: boolean }) {
  const [preview, setPreview] = useState<MigrationPreview>();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'upload' | 'preview' | 'import'>();
  const [uploaded, setUploaded] = useState(0);
  const [file, setFile] = useState<File>();
  const client = useQueryClient();
  const { data: progress, refetch: reload } = useQuery<MigrationProgress>({ queryKey: ['/migration/status'], enabled: started });
  useLive('migration.progress', () => {
    if (started) void reload();
  });
  const done = progress !== undefined && progress.pending === 0;

  async function send(file: File) {
    setPreview(undefined);
    setStarted(false);
    setError('');
    setUploaded(0);
    setBusy('upload');
    try {
      const backup = await upload<MigrationBackup>(`/migration/backup?name=${encodeURIComponent(file.name)}`, file, setUploaded);
      setBusy('preview');
      setPreview(await api<MigrationPreview>('/migration/preview', { method: 'POST', body: { backupId: backup.backupId } }));
    } catch (err) {
      setError(describeSourceError(err));
    } finally {
      setBusy(undefined);
    }
  }

  async function start() {
    setError('');
    setBusy('import');
    try {
      await api('/migration/import', { method: 'POST', body: { planId: preview!.planId } });
      // The status of an earlier import stays in the cache. Without this, the buttons of the end show at once.
      client.removeQueries({ queryKey: ['/migration/status'] });
      setStarted(true);
    } catch (err) {
      setError(describeSourceError(err));
    } finally {
      setBusy(undefined);
    }
  }

  const again = (
    <Button
      variant="ghost"
      onClick={() => {
        setStarted(false);
        setPreview(undefined);
        setFile(undefined);
      }}
    >
      {t('Import again')}
    </Button>
  );

  if (started) {
    return embedded ? (
      <>
        <ImportProgress progress={progress} />
        {done && (
          <ModalActions>
            {onClose && <Button onClick={onClose}>{t('Close')}</Button>}
            {again}
          </ModalActions>
        )}
      </>
    ) : (
      <Section
        title={t('Importing')}
        actions={
          done && (
            <>
              {onFinish && <Button onClick={onFinish}>{t('Continue')}</Button>}
              {again}
            </>
          )
        }
      >
        <ImportProgress progress={progress} />
      </Section>
    );
  }

  const series = preview?.rows.filter((row) => row.mediaType === 'tv').length ?? 0;
  const movies = preview ? preview.rows.length - series : 0;
  const sourceApp = preview?.app === 'radarr' ? { label: t('Movies'), count: movies } : { label: t('Series'), count: series };
  const total = preview ? preview.counts.new + preview.counts.pending + preview.counts.verify : 0;
  const action = preview ? (
    <Button disabled={total === 0} pending={busy === 'import'} onClick={() => void start()}>
      {t('Import {count} titles', { count: total })}
    </Button>
  ) : (
    <Button disabled={!file} pending={busy === 'upload' || busy === 'preview'} onClick={() => file && void send(file)}>
      {t('Continue')}
    </Button>
  );

  const content = (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <FileField
        width="full"
        label={t('Backup file')}
        placeholder={t('Choose backup file')}
        value={file?.name}
        accept=".zip,application/zip"
        disabled={busy !== undefined}
        onFile={(next) => {
          setFile(next);
          setPreview(undefined);
          setStarted(false);
          setError('');
        }}
      />
      {busy === 'upload' && <ProgressBar value={uploaded * 100} label={t('Uploading')} />}
      {preview && (
        <div className="grid w-full grid-cols-4 gap-6">
          <Details items={[{ label: sourceApp.label, value: <Text variant="heading">{sourceApp.count}</Text> }]} />
          <Details items={[{ label: t('New'), value: <Text variant="heading">{preview.counts.new}</Text> }]} />
          <Details items={[{ label: t('In catalog'), value: <Text variant="heading">{preview.counts.matched + preview.counts.imported}</Text> }]} />
          <Details items={[{ label: t('Conflicts'), value: <Text variant="heading">{preview.counts.conflict}</Text> }]} />
        </div>
      )}
      {embedded ? <ModalActions>{action}</ModalActions> : <div className="flex w-full justify-end">{action}</div>}
    </>
  );

  return embedded ? (
    content
  ) : (
    <Section
      title={t('Import from Sonarr or Radarr')}
      actions={
        onFinish && (
          <Button variant="ghost" onClick={onFinish}>
            {t('Skip')}
          </Button>
        )
      }
    >
      {content}
    </Section>
  );
}
