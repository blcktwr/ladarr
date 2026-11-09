import type { SearchResult, UntitledFolder } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../../lib/api.ts';
import { Button, EmptyState, Field, Form, List, Pane, Row, Section, Spinner } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/index.ts';
import { formatBytes } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';

const errorText: Record<string, string> = {
  folder_in_use: 'A title uses this folder already.',
  already_in_library: 'This title is in the library with another folder.',
  folder_not_found: 'The folder is not on the disk.',
  root_unusable: 'The library folder is not available.',
  invalid_folder: 'This folder cannot be used.',
  metadata_unavailable: 'TMDB does not answer. Try again later.',
};

const message = (err: unknown) => t((err instanceof ApiError && errorText[err.message]) || 'The request did not complete. Try again.');

// Searches TMDB for the folder, and gives the folder to the title that the user selects.
function MatchDialog({ folder, onClose, onDone }: { folder: UntitledFolder; onClose: () => void; onDone: () => void }) {
  const [query, setQuery] = useState(folder.guess.title);
  // The first search uses the guess from the folder name.
  const [searched, setSearched] = useState(folder.guess.title);
  const [error, setError] = useState('');
  const [adopting, setAdopting] = useState(false);
  const search = useQuery<{ results: SearchResult[] }>({ queryKey: [`/search?query=${encodeURIComponent(searched.trim())}`] });
  const results = search.data?.results.filter((result) => result.mediaType === folder.mediaType);
  const shown = error || (search.error ? message(search.error) : '');
  const busy = adopting || search.isFetching;

  async function use(result: SearchResult) {
    setAdopting(true);
    setError('');
    try {
      await api('/library/folders/adopt', { method: 'POST', body: { rootId: folder.rootId, folder: folder.folder, tmdbId: result.tmdbId } });
      onDone();
      onClose();
    } catch (err) {
      setError(message(err));
      setAdopting(false);
    }
  }

  return (
    <Section
      title={t('Find the title for {folder}', { folder: folder.folder })}
      actions={
        <Button variant="ghost" autoFocus onClick={onClose}>
          {t('Cancel')}
        </Button>
      }
    >
      {shown && <Alert tone="danger">{shown}</Alert>}
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (!query.trim()) return;
          setError('');
          // The same text again is a retry.
          if (query === searched) void search.refetch();
          else setSearched(query);
        }}
      >
        <Field label={t('Title')} value={query} onValueChange={setQuery} />
        <Button type="submit" variant="ghost" pending={busy}>
          {t('Search')}
        </Button>
      </Form>
      {!results && !shown && <Spinner label={t('Searching')} />}
      {results?.length === 0 && <EmptyState>{t('No titles match.')}</EmptyState>}
      {results && results.length > 0 && (
        <List>
          {results.map((result) => (
            <Row
              key={`${result.mediaType}:${result.tmdbId}`}
              actions={
                <Button disabled={busy} onClick={() => void use(result)}>
                  {t('Use this title')}
                </Button>
              }
            >
              <strong>
                {result.title}
                {result.year ? ` (${result.year})` : ''}
              </strong>
              <p>{result.overview}</p>
            </Row>
          ))}
        </List>
      )}
    </Section>
  );
}

// The folders in the library folders that have video files and no title.
export function UntitledFolders() {
  const navigate = useNavigate();
  const { data, error, isFetching: loading, refetch: reload } = useQuery<{ folders: UntitledFolder[]; skipped: { rootId: string; path: string }[] }>({ queryKey: ['/library/folders'] });
  const [target, setTarget] = useState<UntitledFolder | null>(null);

  if (error && !data) {
    return (
      <Pane>
        <LoadFailed onRetry={reload} />
      </Pane>
    );
  }
  return (
    <Pane>
      <Section
        title={t('Folders without a title')}
        actions={
          <Button variant="ghost" onClick={() => void navigate('/catalog')}>
            {t('Back to the catalog')}
          </Button>
        }
      >
        {data?.skipped.map((root) => (
          <Alert key={root.rootId} tone="warning">
            {t('Cannot read the library folder {path}.', { path: root.path })}
          </Alert>
        ))}
        {target && <MatchDialog key={`${target.rootId}/${target.folder}`} folder={target} onClose={() => setTarget(null)} onDone={reload} />}
        {loading && !data && <Spinner label={t('Loading')} />}
        {data?.folders.length === 0 && <EmptyState>{t('Every folder that has video files has a title.')}</EmptyState>}
        {data && data.folders.length > 0 && (
          <List>
            {data.folders.map((row) => (
              <Row
                key={`${row.rootId}/${row.folder}`}
                actions={
                  <Button variant="ghost" aria-label={t('Find the title for {folder}', { folder: row.folder })} onClick={() => setTarget(row)}>
                    {t('Find title')}
                  </Button>
                }
              >
                <strong>{row.folder}</strong>
                <span>{row.mediaType === 'movie' ? t('Movie') : t('Series')}</span>
                <span>{row.videoFiles === 1 ? t('1 video file') : t('{n} video files', { n: row.videoFiles })}</span>
                <span>{formatBytes(row.sizeBytes)}</span>
              </Row>
            ))}
          </List>
        )}
      </Section>
    </Pane>
  );
}
