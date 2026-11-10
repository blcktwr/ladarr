import type { MediaType } from '@ladarr/shared/enums';
import type { FolderListing, RootRow, SettingsData, SettingsResponse } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useId, useState } from 'react';
import { api } from '../../lib/api.ts';
import { Actions, Button, Dropdown, Field, Form, List, Row, Section, Spinner } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { describeError } from '../../lib/format.ts';
import { languages, t } from '../../i18n/index.ts';
import { WithSettings } from './with-settings.tsx';

const mediaTypes = ['movie', 'tv'] as const;

function Failure({ message }: { message: string }) {
  return <Alert tone="danger">{message}</Alert>;
}

const joinPath = (base: string, name: string) => `${base.replace(/\/$/, '')}/${name}`;

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
  const [picking, setPicking] = useState<MediaType | null>(null);
  const [dir, setDir] = useState('/');
  const listing = useQuery<FolderListing>({ queryKey: [`/roots/browse?path=${encodeURIComponent(dir)}`], enabled: Boolean(picking) });
  const folders = listing.data;
  const changed = mediaTypes.filter((type) => paths[type].trim() !== (saved(type)?.path ?? ''));

  // The list under a field shows the folders of the server, from the top of the disk.
  const browse = (type: MediaType) => {
    setDir('/');
    setPicking(type);
  };
  const openDir = (next: string) => setDir(next);
  const choose = (path: string) => {
    if (!picking) return;
    const type = picking;
    setPaths((current) => ({ ...current, [type]: path }));
    setErrors((current) => ({ ...current, [type]: undefined }));
    setPicking(null);
  };

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
              readOnly
              error={errors[type]}
              value={paths[type]}
              placeholder="/data/media"
              onClick={() => browse(type)}
              action={
                <Button type="button" variant="ghost" onClick={() => browse(type)}>
                  {t('Browse')}
                </Button>
              }
            />
            {picking === type && (
              <div className="grid grid-cols-[minmax(0,1fr)] justify-items-start gap-4 w-full">
                <p>{folders ? folders.path : dir}</p>
                {listing.error && !folders ? (
                  <Alert tone="danger">{describeError(listing.error)}</Alert>
                ) : listing.isFetching && !folders ? (
                  <Spinner label={t('Loading')} />
                ) : folders ? (
                  <List>
                    {folders.parent && (
                      <Row actions={<Button type="button" variant="ghost" onClick={() => openDir(folders.parent!)}>{t('Up')}</Button>}>
                        <span>..</span>
                      </Row>
                    )}
                    {folders.folders.map((name) => (
                      <Row
                        key={name}
                        actions={
                          <Button type="button" variant="ghost" aria-label={t('Open {folder}', { folder: name })} onClick={() => openDir(joinPath(folders.path, name))}>
                            {t('Open')}
                          </Button>
                        }
                      >
                        <span>{name}</span>
                      </Row>
                    ))}
                  </List>
                ) : null}
                <Actions>
                  <Button type="button" variant="ghost" onClick={() => setPicking(null)}>
                    {t('Cancel')}
                  </Button>
                  <Button type="button" disabled={!folders} onClick={() => folders && choose(folders.path)}>
                    {t('Choose')}
                  </Button>
                </Actions>
              </div>
            )}
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
