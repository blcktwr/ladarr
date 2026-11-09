import type { PlanAction, PlanSkip } from '@ladarr/shared/enums';
import type { PlanPreview, PlanRequest, PlanResult } from '@ladarr/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { t } from '../../i18n/index.ts';
import { fileCount, SearchPlanButton, titleCount } from './calendar-filters.tsx';
import { alert, Button, Confirm, List, Row, Switch } from 'nebula';
import { Alert } from '../../components/index.ts';

// --- Selection ---------------------------------------------------------------------------------

export function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return {
    selected,
    has: (key: string) => selected.has(key),
    toggle: (key: string) =>
      setSelected((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    clear: () => setSelected(new Set()),
  };
}
export type Selection = ReturnType<typeof useSelection>;

// --- Text --------------------------------------------------------------------------------------

const skipText: Record<PlanSkip | 'title_gone' | 'files_not_deleted', string> = {
  import_running: 'An import runs for this title. It is left as it is.',
  root_unavailable: 'The library folder is missing, or its disk is not mounted. The title is left as it is.',
  title_gone: 'The title is not in the library now.',
  files_not_deleted: 'Some files were not deleted. The title stays in the library.',
};

const failText: Record<string, string> = {
  outside_root: 'The file is outside the library folder.',
  not_a_file: 'The path is not a file.',
  unreadable: 'The file cannot be read.',
  changed: 'The file changed after the preview.',
  import_running: 'An import started for this title.',
};

const errorText: Record<string, string> = {
  plan_too_large: 'The plan has more than 5000 files. Select fewer titles.',
  invalid_keys: 'Select 1 to 500 titles.',
  not_found: 'A selected title is not in the library.',
  metadata_unavailable: 'TMDB does not answer. Try again later.',
  plan_not_found: 'The preview expired. Start again.',
  plan_changed: 'The library or the disk changed after the preview. Preview again.',
};

const planError = (err: unknown) => t((err instanceof ApiError && errorText[err.message]) || 'The request did not complete. Try again.');

export const episodeLabel = (episodes: { season: number; number: number }[]) => episodes.map((e) => `S${String(e.season).padStart(2, '0')}E${String(e.number).padStart(2, '0')}`).join(', ');

const question: Record<PlanAction, string> = {
  pause: 'Pause {titles}?',
  resume: 'Resume {titles}?',
  refresh: 'Refresh the metadata of {titles}?',
  preset: 'Set the quality of {titles}?',
  remove: 'Remove {titles}?',
  delete_files: 'Delete the files of {titles}?',
};

const confirmText: Record<PlanAction, string> = {
  pause: 'Pause',
  resume: 'Resume',
  refresh: 'Refresh',
  preset: 'Set quality',
  remove: 'Remove',
  delete_files: 'Delete files',
};

// --- The preview and the confirmation ----------------------------------------------------------

function Outcome({ result }: { result: PlanResult }) {
  return (
    <>
      <p>
        {result.changed === 1 ? t('1 title changed.') : t('{n} titles changed.', { n: result.changed })}{' '}
        {result.deleted > 0 && (result.deleted === 1 ? t('1 file deleted.') : t('{n} files deleted.', { n: result.deleted }))}
      </p>
      {result.skipped.length > 0 && (
        <List>
          {result.skipped.map((row) => (
            <Row key={row.key}>
              {row.key}: {t(skipText[row.reason as keyof typeof skipText] ?? row.reason)}
            </Row>
          ))}
        </List>
      )}
      {result.failed.length > 0 && (
        <List>
          {result.failed.map((row) => (
            <Row key={row.path}>
              {row.path}: {t(failText[row.reason] ?? 'The file cannot be deleted ({reason}).', { reason: row.reason })}
            </Row>
          ))}
        </List>
      )}
    </>
  );
}

// What a finished action tells the user, or nothing when it changed nothing. A season removal keeps its title.
const doneText = (request: PlanRequest, result: PlanResult, subject?: string | null) =>
  request.action === 'remove' && request.season !== undefined
    ? ''
    : request.action === 'remove' && result.changed > 0
      ? subject
        ? t('{title} removed from the library', { title: subject })
        : result.changed === 1
          ? t('1 title removed')
          : t('{n} titles removed', { n: result.changed })
      : request.action === 'delete_files' && result.deleted > 0
        ? result.deleted === 1
          ? t('1 file deleted')
          : t('{n} files deleted', { n: result.deleted })
        : '';

// An alert that asks before an action. The plan is made when the user confirms, so the switch makes no request.
// `subject` names the title of a single action in the alert that follows it.
export function PlanDialog({ request, subject, onClose, onDone }: { request: PlanRequest | null; subject?: string | null; onClose: () => void; onDone: (result: PlanResult) => void }) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  // A new request starts with no result, no error, and the files kept.
  useEffect(() => {
    setResult(null);
    setError('');
    setDeleteFiles(false);
  }, [request]);

  async function confirm() {
    if (!request) return;
    setBusy(true);
    setError('');
    try {
      const plan = await api<PlanPreview>('/library/plans', { method: 'POST', body: request.action === 'remove' ? { ...request, deleteFiles } : request });
      const done = await api<PlanResult>(`/library/plans/${plan.planId}/apply`, { method: 'POST', body: {} });
      if (done.skipped.length || done.failed.length) setResult(done);
      else finish(done);
    } catch (err) {
      setError(planError(err));
    } finally {
      setBusy(false);
    }
  }

  function finish(done: PlanResult) {
    const title = request ? doneText(request, done, subject) : '';
    if (title) alert.success(title);
    // The catalog shows the change at once, even when the live event does not arrive.
    void queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('/library') });
    onDone(done);
    onClose();
  }

  const action = request?.action;

  if (!request || !action) return null;
  return (
    <Confirm
      open
      // The request in flight must end first. After a result, closing the alert finishes the action.
      onOpenChange={(open) => !open && !busy && (result ? finish(result) : onClose())}
      title={
        request.fileIds
          ? t('Delete {files}?', { files: fileCount(request.fileIds.length) })
          : request.action === 'remove' && request.season !== undefined
            ? t('Remove {season}?', { season: subject ?? '' })
            : t(question[action], { titles: titleCount(request.keys.length) })
      }
      confirm={t(confirmText[action])}
      pending={busy}
      disabled={Boolean(result)}
      onConfirm={() => void confirm()}
    >
      {action === 'remove' && !result && <Switch label={t('Delete the files too')} checked={deleteFiles} onCheckedChange={setDeleteFiles} />}
      {error && <Alert tone="danger">{error}</Alert>}
      {result && <Outcome result={result} />}
    </Confirm>
  );
}

// --- The actions of the selected titles --------------------------------------------------------

// The buttons are for the toolbar of the library list. The list shows PlanDialog for the removal.
export function BulkActions({ selection, onRemove }: { selection: Selection; onRemove: (request: PlanRequest) => void }) {
  const keys = [...selection.selected];
  if (!keys.length) return null;
  return (
    <>
      <SearchPlanButton label={t('Search')} heading={t('Search the selected titles')} request={{ kind: 'search', keys }} />
      <Button variant="ghost" onClick={() => onRemove({ action: 'remove', keys })}>
        {t('Remove')}
      </Button>
    </>
  );
}
