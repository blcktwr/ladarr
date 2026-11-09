import type { SetupData } from '@ladarr/shared/types';
import { useEffect, useId, useState } from 'react';
import { Button, Field, Form, Modal, Pane, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { describeError } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { Migration } from '../settings/migration.tsx';
import { useAuth } from '../auth/auth.tsx';
import { SetupConnections } from './setup-checks.tsx';
import logo from '../../assets/logo.svg';

// The browser knows the region and the time zone of the user.
const detectedRegion = () => navigator.language.split('-')[1]?.toUpperCase() ?? 'US';
const detectedTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Errors = Partial<Record<'movie' | 'tv' | 'region' | 'timeZone' | 'form', string>>;

// The password view unmounts the setup. This flag sends the person back to the folders after it, not to the last step.
let showFoldersAfterAccess = false;

export function Setup({ data, onDone }: { data: SetupData; onDone: () => void }) {
  const { editAccess } = useAuth();
  const formId = useId();
  const { settings, roots } = data;
  const saved = (type: 'movie' | 'tv') => roots.find((root) => root.id === settings.defaultRoots[type]);
  // The roots of this run are not in the props until the data loads again, so the form remembers what it saved.
  const [savedNow, setSavedNow] = useState<Set<'movie' | 'tv'>>(new Set());
  const isSaved = (type: 'movie' | 'tv') => Boolean(saved(type)) || savedNow.has(type);
  const region = settings.setupCompleted ? settings.region : detectedRegion();
  const [timeZone, setTimeZone] = useState(settings.setupCompleted ? settings.timeZone : detectedTimeZone());
  const [paths, setPaths] = useState({ movie: saved('movie')?.path ?? '', tv: saved('tv')?.path ?? '' });
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // After the folders are saved, the setup checks the connections. The user can go on with a connection that is not ready.
  // A folder pair that is saved already means a reload in the middle of the setup opens the connections step again.
  const [checkConnections, setCheckConnections] = useState(() => {
    if (showFoldersAfterAccess) return false;
    return Boolean(saved('movie') && saved('tv'));
  });
  useEffect(() => {
    showFoldersAfterAccess = false;
  }, []);

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const found: Errors = {};
    const stored = new Set(savedNow);
    try {
      // A folder saved by an earlier try stays. Only the missing ones are added.
      for (const type of ['movie', 'tv'] as const) {
        if (saved(type) || stored.has(type)) continue;
        const path = paths[type].trim();
        if (!path) {
          found[type] = t('Enter a full path that starts with /.');
          continue;
        }
        try {
          await api('/roots', { method: 'POST', body: { path, mediaType: type } });
          stored.add(type);
        } catch (err) {
          found[type] = describeError(err);
        }
      }
      if (Object.keys(found).length) return;
      try {
        await api('/settings', { method: 'PATCH', body: { region: region.trim().toUpperCase(), timeZone: timeZone.trim() } });
      } catch (err) {
        const field = err instanceof ApiError ? err.body.field : undefined;
        if (field === 'region' || field === 'timeZone') found[field] = field === 'region' ? t('Enter a region code of 2 letters, for example US.') : t('Enter a time zone such as America/New_York.');
        else found.form = describeError(err);
        return;
      }
      setCheckConnections(true);
    } catch (err) {
      found.form = describeError(err);
    } finally {
      setErrors(found);
      setSavedNow(stored);
      setPending(false);
      // A saved folder changes what the form shows, so load the data again.
      onDone();
    }
  }

  // The setup ends after the last step.
  async function finishSetup() {
    try {
      await api('/settings/complete-setup', { method: 'POST', body: {} });
    } finally {
      onDone();
    }
  }

  const folder = (type: 'movie' | 'tv', label: string) => (
    <Field
      key={type}
      width="full"
      label={label}
      aria-required="true"
      readOnly={isSaved(type)}
      error={errors[type]}
      value={paths[type]}
      placeholder="/data/media"
      onValueChange={(value) => {
        setPaths({ ...paths, [type]: value });
        // An invalid field blocks the form, so a new value clears its error.
        setErrors({ ...errors, [type]: undefined });
      }}
    />
  );

  if (checkConnections) {
    return (
      <SetupConnections
        onBack={() => setCheckConnections(false)}
        onContinue={() => void finishSetup()}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <img src={logo} alt="Ladarr" width={64} height={64} />
      <Text variant="title" className="w-[min(28rem,calc(100%-40px))]">{t('Where is the media?')}</Text>
      <Pane className="w-[min(28rem,calc(100%-40px))]">
        {errors.form && <Alert tone="danger">{errors.form}</Alert>}
        <Form id={formId} onSubmit={submit}>
          {folder('movie', t('Movies folder'))}
          {folder('tv', t('Series folder'))}
          <Field
            width="full"
            label={t('Time zone')}
            aria-required="true"
            error={errors.timeZone}
            value={timeZone}
            onValueChange={(value) => {
              setTimeZone(value);
              setErrors({ ...errors, timeZone: undefined });
            }}
          />
        </Form>
      </Pane>
      <div className="flex w-[min(28rem,calc(100%-40px))] items-center justify-between">
        <Button type="button" variant="ghost" onClick={() => { showFoldersAfterAccess = true; editAccess(); }}>
          {t('Back')}
        </Button>
        <div className="flex items-center gap-3">
          <Modal
            trigger={<Button type="button" variant="ghost">{t('Import')}</Button>}
            open={importOpen}
            onOpenChange={setImportOpen}
            title={t('Import from Sonarr or Radarr')}
          >
            <Migration embedded onClose={() => setImportOpen(false)} />
          </Modal>
          <Button type="submit" form={formId} pending={pending}>
            {t('Continue')}
          </Button>
        </div>
      </div>
    </div>
  );
}
