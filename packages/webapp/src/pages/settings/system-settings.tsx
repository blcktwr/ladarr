import type { BackupsResponse, UpdateCheck, VersionInfo } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { Badge, Button, Details, Divider, EmptyState, List, Row, Section, Spinner, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { formatBytes, describeError } from '../../lib/format.ts';
import { getLanguage, t } from '../../i18n/index.ts';
import { RestoreBackup, RestoreFile } from './restore.tsx';

const kindLabel = { auto: 'Automatic', manual: 'Manual', safety: 'Safety' };

export function SystemVersion() {
  const { data, error, isFetching: loading, refetch: reload } = useQuery<VersionInfo>({ queryKey: ['/system/version'] });
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState('');

  async function check() {
    setFailed(false);
    setResult(null);
    setPending(true);
    try {
      setResult(await api<UpdateCheck>('/system/update'));
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  async function install() {
    setFailed(false);
    setInstalled('');
    setInstalling(true);
    try {
      const applied = await api<{ version: string }>('/system/update', { method: 'POST', body: {} });
      setInstalled(applied.version);
    } catch {
      setFailed(true);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <Section
      title={t('System')}
      action={
        <Button pending={pending} disabled={!data} onClick={() => void check()}>
          {t('Check updates')}
        </Button>
      }
    >
      {error && !data ? (
        <LoadFailed onRetry={reload} />
      ) : loading && !data ? (
        <Spinner label={t('Loading')} />
      ) : (
        <Details items={[{ label: t('Installed version'), value: data?.version ?? '' }]} />
      )}
      {result && !result.available && <Text variant="body" className="w-full text-center text-success">{t('You have the latest version.')}</Text>}
      {installing ? (
        <div className="grid w-full justify-items-center">
          <Spinner label={t('Installing update')} />
        </div>
      ) : result?.available ? (
        <>
          <Divider />
          <div className="flex w-full items-center justify-between gap-4">
            <Text variant="heading">{t('New version {version}', { version: result.latest })}</Text>
            <Button pending={installing} onClick={() => void install()}>
              {t('Install update')}
            </Button>
          </div>
          {result.notes && <pre>{result.notes}</pre>}
        </>
      ) : null}
      {installed && <Text variant="body" className="w-full text-center text-success">{t('Version {version} installed, the server will restart...', { version: installed })}</Text>}
      {failed && <Alert tone="danger">{t('The request did not complete.')}</Alert>}
    </Section>
  );
}

export function Backups() {
  const { data, error, isFetching: loading, refetch: reload } = useQuery<BackupsResponse>({ queryKey: ['/backups'] });
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setMessage('');
    try {
      await action();
      reload();
    } catch (err) {
      setMessage(describeError(err));
    }
  }

  return (
    <Section title={t('Backups')}
      action={
        <>
          <RestoreFile />
          <Button
            pending={pending}
            onClick={async () => {
              setPending(true);
              await run(() => api('/backups', { method: 'POST', body: {} }));
              setPending(false);
            }}
          >
            {t('Back up now')}
          </Button>
        </>
      }
    >
      {error && !data ? <LoadFailed onRetry={reload} /> : loading && !data ? <Spinner label={t('Loading')} /> : null}
      {message && <Alert tone="danger">{message}</Alert>}
      {data?.backups.length === 0 && <EmptyState>{t('No backups.')}</EmptyState>}
      <List>
        {data?.backups.map((backup) => (
          <Row
            key={backup.name}
            actions={
              <>
                <RestoreBackup name={backup.name} createdAt={backup.createdAt} />
                <Button variant="ghost" onClick={() => location.assign(new URL(`api/backups/${backup.name}/download`, document.baseURI))}>
                  {t('Download')}
                </Button>
                <Button variant="ghost" onClick={() => void run(() => api(`/backups/${backup.name}`, { method: 'DELETE' }))}>
                  {t('Delete')}
                </Button>
              </>
            }
          >
            <span>{new Date(backup.createdAt).toLocaleString(getLanguage())}</span>
            <Badge>{t(kindLabel[backup.kind])}</Badge>
            <span>{formatBytes(backup.bytes)}</span>
          </Row>
        ))}
      </List>
    </Section>
  );
}
