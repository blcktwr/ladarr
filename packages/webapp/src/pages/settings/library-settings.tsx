import type { MediaType } from '@ladarr/shared/enums';
import type { RootRow, SettingsData, SettingsResponse } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useId, useState } from 'react';
import { api } from '../../lib/api.ts';
import { Button, Dropdown, Field, Form, Section, Spinner } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { describeError } from '../../lib/format.ts';
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
      <div className="flex flex-wrap items-start justify-between gap-4 w-full">
        <Dropdown label={t('Language')} value={settings.language} options={Object.entries(languages).map(([value, label]) => ({ value, label }))} onValueChange={(value) => void saveSetting({ language: value as string })} />
        <Dropdown label={t('Theme')} value={settings.theme} options={[{ value: 'dark', label: t('Dark') }, { value: 'light', label: t('Light') }]} onValueChange={(value) => void saveSetting({ theme: value as string })} />
      </div>
    </>
  );
}

function FoldersForm({ roots, defaults, reload }: { roots: RootRow[]; defaults: SettingsData['defaultRoots']; reload: () => void }) {
  const formId = useId();
  const saved = (type: MediaType) => roots.find((root) => root.id === defaults[type]);
  const [paths, setPaths] = useState(() => ({ movie: saved('movie')?.path ?? '', tv: saved('tv')?.path ?? '' }));
  const [errors, setErrors] = useState<Partial<Record<MediaType, string>>>({});
  const [pending, setPending] = useState(false);
  const changed = mediaTypes.filter((type) => paths[type].trim() !== (saved(type)?.path ?? ''));

  async function save(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    setPending(true);
    const found: Partial<Record<MediaType, string>> = {};
    try {
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
      await reload();
    } finally {
      setErrors(found);
      setPending(false);
    }
  }

  return (
    <Section title={t('Folders')} action={<Button form={formId} type="submit" pending={pending}>{t('Save')}</Button>}>
      <Form id={formId} onSubmit={save}>
        {mediaTypes.map((type) => (
          <Fragment key={type}>
            <Field
              width="full"
              label={t(type === 'movie' ? 'Movies folder' : 'Series folder')}
              required
              error={errors[type]}
              value={paths[type]}
              placeholder="/data/media"
              onValueChange={(path) => {
                setPaths((current) => ({ ...current, [type]: path }));
                setErrors((current) => ({ ...current, [type]: undefined }));
              }}
            />
          </Fragment>
        ))}
      </Form>
    </Section>
  );
}

function FoldersCard({ defaults }: { defaults: SettingsData['defaultRoots'] }) {
  const { data, error, refetch: reload } = useQuery<{ roots: RootRow[] }>({ queryKey: ['/roots'] });

  if (error && !data) return <Section title={t('Folders')}><LoadFailed onRetry={reload} /></Section>;
  if (!data) return <Section title={t('Folders')}><Spinner label={t('Loading')} /></Section>;
  return <FoldersForm roots={data.roots} defaults={defaults} reload={reload} />;
}

export const GeneralSettings = () => <WithSettings>{(data, reload) => <GeneralCard data={data} reload={reload} />}</WithSettings>;
export const FolderSettings = () => <WithSettings>{(data) => <FoldersCard defaults={data.settings.defaultRoots} />}</WithSettings>;
