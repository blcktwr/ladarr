import type { RenameCheck, SettingsData } from '@ladarr/shared/types';
import { useEffect, useId, useState } from 'react';
import { api } from '../../lib/api.ts';
import { Button, Field, Form, Section } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { describeError } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { templateError } from '../../lib/import-labels.ts';
import { WithSettings } from './with-settings.tsx';

function Failure({ message }: { message: string }) {
  return <Alert tone="danger">{message}</Alert>;
}

function NamingCard({ settings, reload }: { settings: SettingsData; reload: () => void }) {
  const formId = useId();
  const [movie, setMovie] = useState(settings.naming.movie);
  const [episode, setEpisode] = useState(settings.naming.episode);
  const [check, setCheck] = useState<RenameCheck | null>(null);
  const [examples, setExamples] = useState<RenameCheck['examples']>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  // A short wait joins the key strokes into one request. The sample name shows under each field.
  useEffect(() => {
    const timer = setTimeout(() => {
      void api<RenameCheck>('/rename/examples', { method: 'POST', body: { movie, episode } })
        .then((result) => setExamples(result.examples))
        .catch(() => setExamples(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [movie, episode]);

  // Asks the server if the names are valid, and for a sample name of each.
  async function validate() {
    const result = await api<RenameCheck>('/rename/examples', { method: 'POST', body: { movie, episode } });
    setCheck(result);
    return !result.problems.movie && !result.problems.episode;
  }

  async function run(action: () => Promise<void>) {
    setMessage('');
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setMessage(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      if (!(await validate())) return;
      await api('/settings', { method: 'PATCH', body: { naming: { movie, episode } } });
      reload();
    });

  const changed = (set: (value: string) => void) => (value: string) => {
    set(value);
    setCheck(null);
  };

  return (
    <Section title={t('File names')} action={<Button form={formId} type="submit" pending={busy}>{t('Save')}</Button>}>
      <Form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {message && <Failure message={message} />}
        <Field width="full" label={t('Movie file name')} required description={examples?.movie} error={check?.problems.movie ? templateError(check.problems.movie, 'movie') : undefined} value={movie} onValueChange={changed(setMovie)} />
        <Field width="full" label={t('Episode file name')} required description={examples?.episode} error={check?.problems.episode ? templateError(check.problems.episode, 'episode') : undefined} value={episode} onValueChange={changed(setEpisode)} />
      </Form>
    </Section>
  );
}


export const NamingSettings = () => <WithSettings>{({ settings }, reload) => <NamingCard settings={settings} reload={reload} />}</WithSettings>;
