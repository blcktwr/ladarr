import type { MediaType } from '@ladarr/shared/enums';
import type { RenameCheck, RootRow, SettingsData, SettingsResponse } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';
import { Button, Divider, Dropdown, Field, Form, Section, Spinner } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { describeError } from '../../lib/format.ts';
import { templateError } from '../../lib/import-labels.ts';
import { languages, t } from '../../i18n/index.ts';
import { WithSettings } from './with-settings.tsx';

const mediaTypes = ['movie', 'tv'] as const;

function Failure({ message }: { message: string }) {
  return <Alert tone="danger">{message}</Alert>;
}

function GeneralCard({ data, reload }: { data: SettingsResponse; reload: () => void }) {
  const { settings } = data;
  const [message, setMessage] = useState('');

  async function saveSetting(body: { language: string } | { theme: string }) {
    setMessage('');
    try {
      await api('/settings', { method: 'PATCH', body });
      reload();
    } catch (err) {
      setMessage(describeError(err));
    }
  }

  return (
    <>
      {message && <Failure message={message} />}
      <div className="flex flex-col items-start gap-4 w-full">
        <Dropdown label={t('Language')} value={settings.language} options={Object.entries(languages).map(([value, label]) => ({ value, label }))} onValueChange={(value) => void saveSetting({ language: value as string })} />
        <Dropdown label={t('Theme')} value={settings.theme} options={[{ value: 'dark', label: t('Dark') }, { value: 'light', label: t('Light') }]} onValueChange={(value) => void saveSetting({ theme: value as string })} />
      </div>
    </>
  );
}

function FoldersForm({ roots, settings, reloadRoots, reloadSettings }: {
  roots: RootRow[];
  settings: SettingsData;
  reloadRoots: () => Promise<unknown>;
  reloadSettings: () => void;
}) {
  const saved = (type: MediaType) => roots.find((root) => root.id === settings.defaultRoots[type]);
  const [paths, setPaths] = useState(() => ({ movie: saved('movie')?.path ?? '', tv: saved('tv')?.path ?? '' }));
  const [errors, setErrors] = useState<Partial<Record<MediaType, string>>>({});
  const [naming, setNaming] = useState(settings.naming);
  const [problems, setProblems] = useState<RenameCheck['problems'] | null>(null);
  const [examples, setExamples] = useState<RenameCheck['examples']>(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const changed = mediaTypes.filter((type) => paths[type].trim() !== (saved(type)?.path ?? ''));
  const namesChanged = naming.movie !== settings.naming.movie || naming.episode !== settings.naming.episode;

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void api<RenameCheck>('/rename/examples', { method: 'POST', body: naming })
        .then((result) => { if (active) setExamples(result.examples); })
        .catch(() => { if (active) setExamples(null); });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [naming]);

  async function save(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setErrors({});
    setMessage('');
    setPending(true);
    const found: Partial<Record<MediaType, string>> = {};
    try {
      if (namesChanged) {
        const result = await api<RenameCheck>('/rename/examples', { method: 'POST', body: naming });
        setProblems(result.problems);
        if (result.problems.movie || result.problems.episode) return;
      }
      for (const type of changed) {
        const root = saved(type);
        if (!root) continue;
        const path = paths[type].trim();
        try {
          const updated = await api<RootRow>(`/roots/${root.id}`, { method: 'PATCH', body: { path } });
          setPaths((current) => ({ ...current, [type]: updated.path }));
        } catch (err) {
          found[type] = describeError(err);
        }
      }
      if (changed.length) await reloadRoots();
      if (namesChanged && !Object.keys(found).length) {
        await api('/settings', { method: 'PATCH', body: { naming } });
        await reloadSettings();
      }
    } catch (err) {
      setMessage(describeError(err));
    } finally {
      setErrors(found);
      setPending(false);
    }
  }

  return (
    <Form onSubmit={save}>
      <Section title={t('Folders')} action={<Button type="submit" pending={pending}>{t('Save')}</Button>}>
        {message && <Failure message={message} />}
        {mediaTypes.map((type) => (
          <Field
            key={type}
            width="full"
            label={t(type === 'movie' ? 'Movies folder' : 'Series folder')}
            required={!!saved(type)}
            readOnly={pending || !saved(type)}
            error={errors[type]}
            value={paths[type]}
            placeholder="/data/media"
            onValueChange={(path) => {
              setPaths((current) => ({ ...current, [type]: path }));
              setErrors((current) => ({ ...current, [type]: undefined }));
            }}
          />
        ))}
      </Section>
      <div className="-mx-6 justify-self-stretch">
        <Divider />
      </div>
      <Section title={t('File names')}>
        {(['movie', 'episode'] as const).map((kind) => (
          <Field
            key={kind}
            width="full"
            label={t(kind === 'movie' ? 'Movie file name' : 'Episode file name')}
            required
            readOnly={pending}
            value={naming[kind]}
            description={examples?.[kind]}
            error={problems?.[kind] ? templateError(problems[kind], kind) : undefined}
            onValueChange={(value) => {
              setNaming((current) => ({ ...current, [kind]: value }));
              setProblems(null);
            }}
          />
        ))}
      </Section>
    </Form>
  );
}

export function FolderSettings() {
  const { data, error, refetch: reload } = useQuery<{ roots: RootRow[] }>({ queryKey: ['/roots'] });

  if (error && !data) return <Section title={t('Folders')}><LoadFailed onRetry={reload} /></Section>;
  if (!data) return <Section title={t('Folders')}><Spinner label={t('Loading')} /></Section>;
  return <WithSettings>{({ settings }, reloadSettings) => <FoldersForm roots={data.roots} settings={settings} reloadRoots={reload} reloadSettings={reloadSettings} />}</WithSettings>;
}

export const GeneralSettings = () => <WithSettings>{(data, reload) => <GeneralCard data={data} reload={reload} />}</WithSettings>;
