import type { AlertView } from '@ladarr/shared/types';
import { collectProblems } from './health.ts';

// The notices that a page shows to the person. Only the problems of the setup show, so the alerts open Settings. The
// problems of a library folder stay in the status of the system, and a stopped target stays in the queue.
export async function collectAlerts(sources: Parameters<typeof collectProblems>[0]): Promise<AlertView[]> {
  const problems = (await collectProblems(sources)).filter((problem) => !problem.id.startsWith('root_'));
  return problems.map((problem) => ({
    id: `problem:${problem.id}`,
    title: problem.message,
    message: problem.action,
    ...(problem.params ? { params: problem.params } : {}),
  }));
}
