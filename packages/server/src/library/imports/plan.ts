import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { Db, Root } from '../../core/db.ts';
import type { ImportStatus } from './status.ts';
import type { EnqueueInput, Job } from '../../core/jobs.ts';
import type { ImportJournal, JournalStep } from './importer.ts';

// A request that can not start. The code is stable, and the web app has the text.
export class PlanError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export const keyOf = (episode: { season: number; number: number }) => `${episode.season}x${episode.number}`;

// A title with an open journal can not take a second one. Two journals could write the same name.
export const titleBusy = (db: Db, titleKey: string) => Object.values(db.data.imports).some((journal) => journal.titleKey === titleKey);

// A read-only look at the root. It writes nothing, so a preview changes nothing.
// The device number must be the one that the user accepted, or the root may be another disk.
export async function readableRoot(root: Root | undefined): Promise<string> {
  const info = root && (await stat(root.path).catch(() => undefined));
  if (!root || !info?.isDirectory() || info.dev !== root.dev) throw new PlanError('root_unavailable');
  return realpath(root.path);
}

// The file of the library for a target, when the file is on the disk.
export const presentFile = (db: Db, id: string | null) => {
  const file = id ? db.data.files[id] : undefined;
  return file && !file.missing ? file : undefined;
};

// Saves the journal, and asks the worker to run it. The hash of the journal is the key of the job.
export async function openJournal(
  { db, enqueue, status }: { db: Db; enqueue: (input: EnqueueInput) => Job; status: ImportStatus },
  input: { kind: 'import' | 'rename'; titleKey: string; sourceBase: string; steps: JournalStep[]; linkOnly?: true; searchOnFinish?: true },
) {
  const id = randomUUID();
  const journal: ImportJournal = {
    id,
    hash: `${input.kind === 'rename' ? 'rename' : 'manual'}:${id}`,
    titleKey: input.titleKey,
    steps: input.steps,
    createdAt: Date.now(),
    sourceBase: input.sourceBase,
    ...(input.kind === 'rename' ? { kind: 'rename' as const } : {}),
    ...(input.linkOnly ? { linkOnly: true as const } : {}),
    ...(input.searchOnFinish ? { searchOnFinish: true as const } : {}),
  };
  db.data.imports[id] = journal;
  await db.write();
  status.begin(id, input.kind, input.titleKey, input.steps.length);
  enqueue({ type: 'import.run', payload: { hash: journal.hash }, dedupeKey: `import:${journal.hash}` });
  return journal;
}
