import type { SearchResult, SourceFolder, SourcePreview } from '@ladarr/shared/types';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Actions, Badge, Button, Field, Form, List, Modal, Row } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { ModalActions } from '../../components/modal-actions.tsx';
import { api } from '../../lib/api.ts';
import { catalogPath, contentType, formatBytes, rootProblemLabel } from '../../lib/format.ts';
import { requestMessage } from '../../lib/import-labels.ts';
import { t } from '../../i18n/index.ts';
import { Migration } from '../settings/migration.tsx';
import { PlanView, RunProgress } from './title-files.tsx';

const label = (result: SearchResult) => `${result.title}${result.year ? ` (${result.year})` : ''}`;

// Imports a folder that is already on the disk, normally a download folder. The server reads the folder, searches
// TMDB with its name, and links the files into the library after the user confirms the title.
export function AddManuallyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [path, setPath] = useState('');
  const [folder, setFolder] = useState<SourceFolder | null>(null);
  const [choices, setChoices] = useState<SearchResult[] | null>(null);
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [chosen, setChosen] = useState<SearchResult | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [titleKey, setTitleKey] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setPath('');
    setFolder(null);
    setChoices(null);
    setPreview(null);
    setChosen(null);
    setQuery('');
    setError('');
    setBusy(false);
    setRunId(null);
    setTitleKey(null);
  }, [open]);

  async function read() {
    setError('');
    setBusy(true);
    try {
      const answer = await api<{ folder: SourceFolder }>('/import/source/detect', { method: 'POST', body: { path: path.trim() } });
      setFolder(answer.folder);
      setChoices(answer.folder.results);
      setQuery(answer.folder.guess.title);
      setPreview(null);
      setChosen(null);
    } catch (err) {
      setError(requestMessage(err));
      setFolder(null);
      setChoices(null);
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    if (!query.trim()) return;
    setError('');
    setBusy(true);
    try {
      const answer = await api<{ results: SearchResult[] }>(`/search?query=${encodeURIComponent(query.trim())}`);
      setChoices(answer.results);
    } catch (err) {
      setError(requestMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function choose(result: SearchResult) {
    setError('');
    setBusy(true);
    try {
      const answer = await api<{ preview: SourcePreview }>('/import/source/preview', { method: 'POST', body: { path: path.trim(), mediaType: result.mediaType, tmdbId: result.tmdbId } });
      setPreview(answer.preview);
      setChosen(result);
    } catch (err) {
      setError(requestMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!chosen) return;
    setError('');
    setBusy(true);
    try {
      const answer = await api<{ titleKey: string; id: string }>('/import/source', { method: 'POST', body: { path: path.trim(), mediaType: chosen.mediaType, tmdbId: chosen.tmdbId } });
      setTitleKey(answer.titleKey);
      setRunId(answer.id);
    } catch (err) {
      setError(requestMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function openTitle() {
    if (!titleKey) return;
    onClose();
    void navigate(catalogPath(titleKey));
  }

  if (!open) return null;
  return (
    <Modal open onOpenChange={(next) => !next && onClose()} title={t('Add manually')}>
      {error && <Alert tone="danger">{error}</Alert>}
      {runId ? (
        <>
          <RunProgress id={runId} />
          <ModalActions>
            <Button variant="ghost" onClick={onClose}>
              {t('Close')}
            </Button>
            <Button onClick={openTitle}>{t('Open the title')}</Button>
          </ModalActions>
        </>
      ) : preview && chosen ? (
        <>
          <p>{t('Files go to {path}', { path: `${preview.rootPath.replace(/\/$/, '')}/${preview.folder}` })}</p>
          {preview.rootProblems.map((problem) => (
            <Alert key={problem} tone="warning">
              {rootProblemLabel[problem]}
            </Alert>
          ))}
          <PlanView plan={preview.plan} label={label(chosen)} />
          <ModalActions>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              {t('Back')}
            </Button>
            <Button disabled={preview.plan.importable === 0} pending={busy} onClick={() => void start()}>
              {preview.plan.importable === 1 ? t('Import 1 file') : t('Import {n} files', { n: preview.plan.importable })}
            </Button>
          </ModalActions>
        </>
      ) : (
        <>
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (path.trim()) void read();
            }}
          >
            <Field
              label={t('Folder')}
              required
              autoFocus
              width="full"
              placeholder="/data/downloads/Show Name"
              value={path}
              onValueChange={(value) => {
                setPath(value);
                setFolder(null);
                setChoices(null);
              }}
            />
            <Button type="submit" variant="ghost" pending={busy}>
              {t('Read the folder')}
            </Button>
          </Form>
          {folder && (
            <>
              <Actions>
                <Badge>{contentType(folder.mediaType)}</Badge>
                <span>{folder.videoFiles === 1 ? t('1 video file') : t('{n} video files', { n: folder.videoFiles })}</span>
                <span>{formatBytes(folder.sizeBytes)}</span>
              </Actions>
              {folder.truncated && <Alert tone="warning">{t('The folder has more files than can be read. Import a smaller folder.')}</Alert>}
              <p>{t('Looking for {name}', { name: folder.guess.title })}</p>
              {choices && choices.length === 0 && <p>{t('TMDB has no title with this name. Search for it.')}</p>}
              {choices && choices.length > 0 && (
                <List>
                  {choices.map((result) => (
                    <Row
                      key={`${result.mediaType}:${result.tmdbId}`}
                      actions={
                        <Button disabled={busy} onClick={() => void choose(result)}>
                          {t('Use this title')}
                        </Button>
                      }
                    >
                      <strong>{label(result)}</strong>
                      <Badge>{contentType(result.mediaType)}</Badge>
                      <p>{result.overview}</p>
                    </Row>
                  ))}
                </List>
              )}
              <Form
                onSubmit={(event) => {
                  event.preventDefault();
                  void search();
                }}
              >
                <Field label={t('Search a title')} value={query} onValueChange={setQuery} />
                <Button type="submit" variant="ghost" pending={busy}>
                  {t('Search')}
                </Button>
              </Form>
            </>
          )}
          <ModalActions>
            <Button variant="ghost" onClick={onClose}>
              {t('Cancel')}
            </Button>
          </ModalActions>
        </>
      )}
    </Modal>
  );
}

// Imports the backup file of a Sonarr or Radarr database. The migration reads the file, links the titles that the
// catalog lacks, and shows the progress.
export function ImportBackupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <Modal open onOpenChange={(next) => !next && onClose()} title={t('Import from Sonarr or Radarr')}>
      <Migration embedded onClose={onClose} />
    </Modal>
  );
}
