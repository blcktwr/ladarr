import type { QueueJob } from '@ladarr/shared/types';
import { t } from '../i18n/index.ts';

// The action of a job of the item flow. A search that runs now is Searching; a search that waits is Search.
// A type that the page does not know shows as it is.
export const jobAction = (type: string, running = false) => {
  if (type === 'queue.search' || type === 'queue.initial') return running ? t('Searching') : t('Search');
  if (type === 'queue.grab') return t('Send');
  if (type === 'import.run') return t('Import');
  return type;
};

// The name of a job: its action and its target.
export const jobName = (job: QueueJob) => {
  const action = jobAction(job.type, job.state === 'running');
  return job.label ? `${action} ${job.label}` : action;
};
