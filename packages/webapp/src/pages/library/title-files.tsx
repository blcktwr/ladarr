import type { FolderPlan, RenameRow, RunView } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { Actions, Badge, Button, Field, Form, List, Row, Section, Spinner, Switch } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { formatBytes } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { folderStatusColor, folderStatusLabel, problemLabel, requestMessage, stepLabel } from '../../lib/import-labels.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const seasonName = (season: number) => (season === 0 ? t('Specials') : t('Season {n}', { n: season }));

// The Badge calls the plain tone neutral.
const folderStatusTone = (status: string) => {
  const color = folderStatusColor(status);
  return color === 'default' ? 'neutral' : color;
};

function Failure({ message }: { message: string }) {
  return <Alert tone="danger">{message}</Alert>;
}

// The state of a run that the server started: the steps of the journal, the bytes of a copy, and the files that stopped.
export function RunProgress({ id }: { id: string }) {
  // The server forgets a run when it restarts. The library shows the result.
  const isLost = (err: unknown) => err instanceof ApiError && err.status === 404;
  const { data: view, error } = useQuery<RunView>({
    queryKey: [`/import/runs/${id}`],
    refetchInterval: (query) => (query.state.data?.run.finished || isLost(query.state.error) ? false : 700),
  });
  const lost = isLost(error);

  if (lost) return <p>{t('The server restarted. The library shows the result.')}</p>;
  if (!view) return <Spinner label={t('Loading')} />;
  const progress = view.run.total === 1 ? t('{done} of {total} file done', { done: view.run.done, total: view.run.total }) : t('{done} of {total} files done', { done: view.run.done, total: view.run.total });
  return (
    <>
      <p role="status">{view.run.finished ? `${progress}. ${t('The run ended.')}` : progress}</p>
      <List>
        {view.steps.map((step) => (
          <Row key={step.dest}>
            <span>{step.source}</span>
            <span>
              {stepLabel[step.state] ?? step.state}
              {step.method ? ` ${step.method === 'hardlink' ? t('Hard link') : t('Copy')}` : ''}
            </span>
            {step.copiedBytes !== null && (
              <span>
                {t('Copying {copied} of {total} ({percent}%)', {
                  copied: formatBytes(step.copiedBytes),
                  total: formatBytes(step.totalBytes),
                  percent: Math.round((step.copiedBytes / Math.max(step.totalBytes, 1)) * 100),
                })}
              </span>
            )}
          </Row>
        ))}
      </List>
      {view.run.problems.length > 0 && (
        <Section title={t('These files were not changed')}>
          <List>
            {view.run.problems.map((problem) => (
              <Row key={problem.file}>
                {problem.file}: {problemLabel[problem.code] ?? problem.code}
              </Row>
            ))}
          </List>
        </Section>
      )}
    </>
  );
}

// Imports the video files of a folder that the user names. The preview shows each file and changes nothing.
export function ImportFolderDialog({ titleKey, label, isOpen, onClose }: { titleKey: string; label: string; isOpen: boolean; onClose: () => void }) {
  const [path, setPath] = useState('');
  const [replace, setReplace] = useState(false);
  const [plan, setPlan] = useState<FolderPlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  // A new value of the form makes the answer of an earlier preview old. The number tells which answer is the current one.
  const request = useRef(0);
  const reset = () => {
    request.current++;
    setPlan(null);
  };

  useEffect(() => {
    if (isOpen) return;
    reset();
    setError('');
    setRunId(null);
  }, [isOpen]);

  async function ask(route: 'preview' | 'start') {
    setError('');
    setBusy(true);
    try {
      const body = { titleKey, path: path.trim(), replace };
      if (route === 'preview') {
        const mine = ++request.current;
        const answer = await api<{ plan: FolderPlan }>('/import/folder/preview', { method: 'POST', body });
        if (request.current === mine) setPlan(answer.plan);
      } else setRunId((await api<{ id: string }>('/import/folder', { method: 'POST', body })).id);
    } catch (err) {
      setError(requestMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!isOpen) return null;
  return (
    <Section
      title={t('Import a folder for {label}', { label })}
      actions={
        <>
          <Button variant="ghost" autoFocus={Boolean(runId)} onClick={onClose}>
            {runId ? t('Close') : t('Cancel')}
          </Button>
          {!runId && (
            <Button disabled={!plan || plan.importable === 0} pending={busy} onClick={() => void ask('start')}>
              {plan ? (plan.importable === 1 ? t('Import 1 file') : t('Import {n} files', { n: plan.importable })) : t('Import')}
            </Button>
          )}
        </>
      }
    >
      {error && <Failure message={error} />}
      {runId ? (
        <RunProgress id={runId} />
      ) : (
        <>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void ask('preview');
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
                reset();
              }}
            />
            <Switch
              label={t('Replace files that the library has')}
              checked={replace}
              onCheckedChange={(value) => {
                setReplace(value);
                reset();
              }}
            />
            <Button type="submit" variant="ghost" pending={busy}>
              {t('Preview')}
            </Button>
          </Form>
          {plan && <PlanView plan={plan} label={label} />}
        </>
      )}
    </Section>
  );
}

export function PlanView({ plan, label }: { plan: FolderPlan; label: string }) {
  return (
    <>
      <Actions>
        <strong>{label}</strong>
        {plan.nameMatch === false && <Badge tone="warning">{t('The names in the folder do not match this title')}</Badge>}
        {plan.nameMatch === true && <Badge tone="success">{t('The names match this title')}</Badge>}
      </Actions>
      {plan.files.length === 0 && <p>{t('The folder has no video file.')}</p>}
      {plan.truncated && <Alert tone="warning">{t('The folder has more files than can be read. Import a smaller folder.')}</Alert>}
      <List>
        {plan.files.map((file) => (
          <Row key={file.rel}>
            <Badge tone={folderStatusTone(file.status)}>{folderStatusLabel[file.status] ?? file.status}</Badge>
            <span>{file.rel}</span>
            <span>{formatBytes(file.sizeBytes)}</span>
            {file.episodes.length > 0 && <span>{file.episodes.map((e) => `S${pad(e.season)}E${pad(e.number)}`).join(', ')}</span>}
            {(file.status === 'new' || file.status === 'replace' || file.status === 'register') && file.dest && <span>{t('To: {path}', { path: file.dest })}</span>}
            {(file.status === 'replace' || file.status === 'exists') && file.replaces && <span>{t('Library file: {path}', { path: file.replaces })}</span>}
            {file.reason && <span>{problemLabel[file.reason] ?? file.reason}</span>}
          </Row>
        ))}
      </List>
      {plan.coverage.map((season) => (
        <p key={season.season}>
          {season.missing.length
            ? t('{season}: {covered} of {total} episodes in this import. No file for {missing}.', { season: seasonName(season.season), covered: season.covered, total: season.total, missing: season.missing.join(', ') })
            : t('{season}: {covered} of {total} episodes in this import.', { season: seasonName(season.season), covered: season.covered, total: season.total })}
        </p>
      ))}
    </>
  );
}

// Shows the new names of the files of a title after a change of the metadata or of the templates.
export function RenameDialog({ titleKey, label, isOpen, onClose }: { titleKey: string; label: string; isOpen: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<RenameRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    setError('');
    setRunId(null);
    if (!isOpen) return;
    let stopped = false;
    api<{ rows: RenameRow[] }>('/rename/preview', { method: 'POST', body: { titleKey } }).then(
      (data) => !stopped && setRows(data.rows),
      (err) => !stopped && setError(requestMessage(err)),
    );
    return () => {
      stopped = true;
    };
  }, [isOpen, titleKey]);

  async function start() {
    setError('');
    setBusy(true);
    try {
      setRunId((await api<{ id: string }>('/rename/apply', { method: 'POST', body: { titleKey } })).id);
    } catch (err) {
      setError(requestMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const changes = rows?.filter((row) => row.status === 'rename') ?? [];
  const shown = rows?.filter((row) => row.status !== 'unchanged') ?? [];
  if (!isOpen) return null;
  return (
    <Section
      title={t('Rename the files of {label}', { label })}
      actions={
        <>
          <Button variant="ghost" autoFocus onClick={onClose}>
            {runId ? t('Close') : t('Cancel')}
          </Button>
          {!runId && (
            <Button disabled={changes.length === 0} pending={busy} onClick={() => void start()}>
              {changes.length === 1 ? t('Rename 1 file') : t('Rename {n} files', { n: changes.length })}
            </Button>
          )}
        </>
      }
    >
      {error && <Failure message={error} />}
      {runId ? (
        <RunProgress id={runId} />
      ) : (
        <>
          {!rows && !error && <Spinner label={t('Loading')} />}
          {rows && shown.length === 0 && <p>{t('No file needs a new name.')}</p>}
          <List>
            {shown.map((row) => (
              <Row key={row.fileId}>
                <Badge tone={row.status === 'rename' ? 'success' : 'danger'}>{row.status === 'rename' ? t('Rename') : t('Blocked')}</Badge>
                <span>{row.from}</span>
                {row.to && <span>{t('To: {path}', { path: row.to })}</span>}
                {row.reason && <span>{problemLabel[row.reason] ?? row.reason}</span>}
              </Row>
            ))}
          </List>
        </>
      )}
    </Section>
  );
}
