import { IMPORT_STAGES, type ImportCheckId, type ImportCheckState } from '@ladarr/shared/enums';
import type { ImportCheck, RunStatus } from '@ladarr/shared/types';
import { stat } from 'node:fs/promises';
import { db } from '../../core/db.ts';
import type { Events } from '../../core/events.ts';
import { queueKey } from '../downloads/queue.ts';

// What the importer is doing now, in memory. The journal and the library hold the facts. This holds the numbers
// that the client reads again after a restart: the bytes of a running copy, the result of a manual import or a rename,
// and the checks of a download import.

export type CopyProgress = { journalId: string; dest: string; entryIds: string[]; copiedBytes: number; totalBytes: number; observedAt: number };

// A check run of an import. One list belongs to the whole group, so every target of a pack shows the same checks.
type CheckRun = { entryIds: string[]; checks: ImportCheck[] };

type CheckResult = { code: string; detail?: string };

const MAX_RUNS = 50;
const PUBLISH_MS = 1_000;

export function createImportStatus(events: Events, { pollMs = 500, now = Date.now }: { pollMs?: number; now?: () => number } = {}) {
  const copies = new Map<string, CopyProgress>();
  const runs = new Map<string, RunStatus>();
  const checkRuns = new Map<string, CheckRun>();
  let lastPublish = 0;

  function publish(force: boolean) {
    const at = now();
    if (!force && at - lastPublish < PUBLISH_MS) return;
    lastPublish = at;
    events.publish('import.copy', { at, copies: [...copies.values()] });
  }

  function listOf(entryId: string) {
    for (const run of checkRuns.values()) if (run.entryIds.includes(entryId)) return run.checks.map((check) => ({ ...check }));
    return null;
  }

  // Every state change of a check goes out at once. The page reads the sequence, so this event has no throttle.
  // Only the targets of an import are in it, and they carry a copy of the list at the moment of the event.
  function publishChecks(_key?: string) {
    const at = now();
    const entries = Object.values(db.data.queue).flatMap((entry) => {
      if (!IMPORT_STAGES.includes(entry.stage)) return [];
      const checks = listOf(entry.id);
      return checks ? [{ id: entry.id, stage: entry.stage, key: queueKey(entry), checks }] : [];
    });
    events.publish('import.checks', { at, entries });
  }

  return {
    // Reads the size of the staged file while the copy runs. The size on the disk is the measured progress.
    // Call the returned function when the copy ends, whatever the result.
    watchCopy(journalId: string, dest: string, entryIds: string[], stagePath: string, totalBytes: number) {
      const key = `${journalId}:${dest}`;
      const read = async () => {
        const info = await stat(stagePath).catch(() => undefined);
        if (!info || !copies.has(key)) return;
        copies.set(key, { journalId, dest, entryIds, copiedBytes: Math.min(info.size, totalBytes), totalBytes, observedAt: now() });
        publish(false);
      };
      copies.set(key, { journalId, dest, entryIds, copiedBytes: 0, totalBytes, observedAt: now() });
      publish(true);
      const timer = setInterval(() => void read(), pollMs);
      return () => {
        clearInterval(timer);
        copies.delete(key);
        publish(true);
      };
    },

    copyOf: (entryId: string) => [...copies.values()].find((copy) => copy.entryIds.includes(entryId)),
    copyOfStep: (journalId: string, dest: string) => copies.get(`${journalId}:${dest}`),

    // Starts the checks of an import. A run that holds one of these targets ends here, so a target has one list.
    startChecks(key: string, entryIds: string[], ids: readonly ImportCheckId[]) {
      for (const [oldKey, run] of checkRuns) if (run.entryIds.some((id) => entryIds.includes(id))) checkRuns.delete(oldKey);
      checkRuns.delete(key);
      const list: ImportCheck[] = ids.map((id) => ({ id, state: 'pending', code: null, detail: null, at: null }));
      checkRuns.set(key, { entryIds: [...entryIds], checks: list });
      // The oldest runs go first. A map keeps the order of insertion.
      for (const old of [...checkRuns.keys()].slice(0, Math.max(0, checkRuns.size - MAX_RUNS))) checkRuns.delete(old);
      publishChecks();
      return list.map((check) => ({ ...check }));
    },
    setCheck(key: string, id: ImportCheckId, state: ImportCheckState, result?: CheckResult) {
      const run = checkRuns.get(key);
      const check = run?.checks.find((item) => item.id === id);
      if (!check) return;
      check.state = state;
      check.code = result?.code ?? null;
      check.detail = result?.detail ?? null;
      check.at = state === 'pending' ? null : now();
      publishChecks();
    },
    // The importer moved the targets to Importing. The page shows the new stage with the same list.
    publishChecks,
    checksOf: listOf,

    begin(id: string, kind: RunStatus['kind'], titleKey: string, total: number) {
      runs.set(id, { id, kind, titleKey, total, done: 0, problems: [], finished: false, startedAt: now() });
      // The oldest runs go first. A map keeps the order of insertion.
      for (const old of [...runs.keys()].slice(0, Math.max(0, runs.size - MAX_RUNS))) runs.delete(old);
    },
    stepDone(id: string) {
      const run = runs.get(id);
      if (run) run.done++;
    },
    problem(id: string, file: string, code: string, detail?: string) {
      runs.get(id)?.problems.push({ file, code, ...(detail ? { detail } : {}) });
    },
    finish(id: string) {
      const run = runs.get(id);
      if (run) run.finished = true;
    },
    run: (id: string) => runs.get(id),
  };
}

export type ImportStatus = ReturnType<typeof createImportStatus>;
