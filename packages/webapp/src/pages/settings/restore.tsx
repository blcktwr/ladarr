import { useRef, useState } from 'react';
import { api, upload } from '../../lib/api.ts';
import { Button, Modal } from 'nebula';
import { Alert } from '../../components/index.ts';
import { describeError } from '../../lib/format.ts';
import { getLanguage, t } from '../../i18n/index.ts';

const restoreErrors: Record<string, string> = {
  invalid_archive: 'The file is not a backup of this app.',
  checksum_mismatch: 'The backup is damaged.',
  unsupported_schema: 'The backup is from a newer version.',
  backup_too_large: 'The file is too large for a backup.',
  not_found: 'The backup file does not exist.',
  restore_in_progress: 'A restore is in progress. Try again later.',
  worker_busy: 'A job does not stop. Try again later.',
  requests_busy: 'A request does not end. Try again later.',
  setup_closed: 'Setup is already complete. Reload the page to sign in.',
};

// The restore replaces all data, so the modal names what it replaces. After the restore all sessions end, and the page loads again.
function RestoreAlert({ intro, send, onCancel }: { intro: string; send: () => Promise<{ safetyBackup: string }>; onCancel: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function restore() {
    setPending(true);
    setError('');
    try {
      await send();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error && restoreErrors[err.message] ? t(restoreErrors[err.message]!) : describeError(err));
    }
    setPending(false);
  }

  if (done) {
    return (
      <Modal open onOpenChange={() => undefined} title={t('Backup restored')} actions={<Button onClick={() => location.reload()}>{t('Continue')}</Button>}>
        <p>{t('All data imported correctly')}</p>
      </Modal>
    );
  }
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !pending && onCancel()}
      title={t('Restore this backup?')}
      actions={
        <>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button variant="danger" pending={pending} onClick={() => void restore()}>
            {t('Restore')}
          </Button>
        </>
      }
    >
      <p>{intro}</p>
      {error && <Alert tone="danger">{error}</Alert>}
    </Modal>
  );
}

export function RestoreBackup({ name, createdAt }: { name: string; createdAt: number }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button variant="ghost" onClick={() => setAsking(true)}>
        {t('Restore')}
      </Button>
    );
  }
  return <RestoreAlert intro={t('This replaces the app data with the data of the backup from {date}.', { date: new Date(createdAt).toLocaleString(getLanguage()) })} send={() => api<{ safetyBackup: string }>(`/backups/${name}/restore`, { method: 'POST', body: {} })} onCancel={() => setAsking(false)} />;
}

// A Ladarr backup file from outside the backup folder, for example from another machine. The setup screen has no
// owner yet, so its restore goes through the route that has no session. After the owner exists, the setup screen
// returns to the password form with a session, and the restore goes through the route with the session.
export function RestoreFile({ setup = false, route = '/backups/restore' }: { setup?: boolean; route?: '/setup/restore' | '/backups/restore' }) {
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  return (
    <>
      <input
        ref={picker}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
      <Button variant="ghost" onClick={() => picker.current?.click()}>
        {setup ? t('Restore from backup') : t('Import backup')}
      </Button>
      {file && <RestoreAlert intro={t('This replaces the app data with the data of the file.')} send={() => upload<{ safetyBackup: string }>(route, file)} onCancel={() => setFile(null)} />}
    </>
  );
}
