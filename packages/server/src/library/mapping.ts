import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../core/db.ts';
import { entryId } from './downloads/queue.ts';
import { PlanError } from './imports/plan.ts';
import { bindJournal } from './imports/importer.ts';
import { inside } from './roots.ts';
import type { ApplyDeps, Correction, CorrectionCommit, CorrectionRow, Episode, EpisodeRef, ImportJournal, JournalStep, MappingEntry, MediaFile, PointerRow } from '../types.ts';

// A file of the library gets the episodes that it holds, from a mapping that a person reviewed. The correction writes
// the two directions of the record: the coverage of each file, and the file of each episode.

const keyOf = (episode: EpisodeRef) => `${episode.season}x${episode.number}`;
const sorted = (episodes: EpisodeRef[]) => [...episodes].sort((a, b) => a.season - b.season || a.number - b.number);
const same = (a: EpisodeRef[], b: EpisodeRef[]) => a.length === b.length && a.every((episode, at) => keyOf(episode) === keyOf(b[at]!));
const covers = (episodes: EpisodeRef[], episode: Episode) => episodes.some((item) => item.season === episode.season && item.number === episode.number);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const applied = new WeakMap<Correction, string>();

const physicalOf = (file: MediaFile): NonNullable<MediaFile['association']>['identity'] | null | undefined => {
  const title = db.data.titles[file.titleKey];
  const root = title && db.data.roots[title.rootId];
  if (!root) return undefined;
  try {
    if (statSync(root.path).dev !== root.dev) return null;
    const rootReal = realpathSync(root.path);
    const path = realpathSync(join(rootReal, file.path));
    if (!inside(rootReal, path)) return null;
    const info = statSync(path);
    return info.isFile() && info.size > 0 ? { sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino } : null;
  } catch {
    return null;
  }
};

// A scan must not replace a correction that arrived while the scan read the disk.
export const libraryVersion = (titleKey: string) =>
  digest({
    title: db.data.titles[titleKey],
    root: db.data.roots[db.data.titles[titleKey]?.rootId ?? ''],
    files: Object.values(db.data.files).filter((file) => file.titleKey === titleKey).sort((a, b) => a.id.localeCompare(b.id)),
  });

const versionOf = (titleKey: string, entries: MappingEntry[], ids: string[]) =>
  digest({
    library: libraryVersion(titleKey),
    entries,
    ids,
    physical: Object.values(db.data.files).filter((file) => file.titleKey === titleKey).sort((a, b) => a.id.localeCompare(b.id)).map((file) => [file.id, physicalOf(file)]),
    queue: Object.values(db.data.queue).filter((entry) => entry.titleKey === titleKey).sort((a, b) => a.id.localeCompare(b.id)),
  });

// The episodes of one entry, or the reason why they can not be written.
function check(entry: MappingEntry, catalog: Set<string>): { reason: CorrectionRow['reason']; episodes: EpisodeRef[] } {
  const episodes = sorted(entry.episodes);
  const keys = episodes.map(keyOf);
  if (new Set(keys).size !== keys.length) return { reason: 'duplicate', episodes };
  if (keys.some((key) => !catalog.has(key))) return { reason: 'episode_missing', episodes };
  return { reason: null, episodes };
}

// Reads the request against the library. It changes nothing.
export function correctionOf(titleKey: string, entries: MappingEntry[], ids: string[] = []): Correction {
  const title = db.data.titles[titleKey];
  if (!title) throw new PlanError('title_not_found');
  if (title.mediaType !== 'tv') throw new PlanError('not_a_series');
  entries = entries.map((entry) => ({ path: entry.path, episodes: sorted(entry.episodes).map((episode) => ({ ...episode })) })).sort((a, b) => a.path.localeCompare(b.path));
  ids = [...new Set(ids)].sort();
  if (ids.some((id) => db.data.queue[id]?.titleKey !== titleKey)) throw new PlanError('invalid_ids');
  const catalog = new Set(title.episodes.map(keyOf));
  const files = Object.values(db.data.files)
    .filter((file) => file.titleKey === titleKey)
    .sort((a, b) => a.path.localeCompare(b.path));
  const byPath = new Map<string, MappingEntry>();
  for (const entry of entries) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);

  const rows: CorrectionRow[] = [];
  // The paths that claim an episode, to find an episode that two files claim.
  const claims = new Map<string, string[]>();

  for (const file of files) {
    const from = sorted(file.episodes);
    const entry = byPath.get(file.path);
    if (!entry) {
      rows.push({ fileId: file.id, path: file.path, from, to: from, status: 'same', reason: null });
      continue;
    }
    // A file that is gone keeps its coverage until a person removes it.
    if (entry.episodes.length && (file.missing || physicalOf(file) === null)) {
      rows.push({ fileId: file.id, path: file.path, from, to: from, status: 'review', reason: 'file_missing' });
      continue;
    }
    const checked = check(entry, catalog);
    if (entries.filter((item) => item.path === file.path).length > 1) checked.reason = 'duplicate';
    if (checked.reason) {
      rows.push({ fileId: file.id, path: file.path, from, to: checked.episodes, status: 'blocked', reason: checked.reason });
      continue;
    }
    rows.push({ fileId: file.id, path: file.path, from, to: checked.episodes, status: same(from, checked.episodes) ? 'same' : 'change', reason: null });
    for (const episode of checked.episodes) claims.set(keyOf(episode), [...(claims.get(keyOf(episode)) ?? []), file.path]);
  }

  // An entry for a path that the title does not hold.
  const known = new Set(files.map((file) => file.path));
  for (const entry of entries) {
    if (known.has(entry.path)) continue;
    rows.push({ fileId: '', path: entry.path, from: [], to: sorted(entry.episodes), status: 'blocked', reason: 'path_unknown' });
  }

  // Omitted files keep their coverage. An assignment cannot silently replace that coverage.
  for (const row of rows) {
    if (byPath.has(row.path) || files.find((file) => file.id === row.fileId)?.missing) continue;
    for (const episode of row.from) claims.set(keyOf(episode), [...(claims.get(keyOf(episode)) ?? []), row.path]);
  }
  // One episode, one file. Two files that claim the same episode are both held back.
  for (const paths of claims.values()) {
    if (paths.length < 2 || !paths.some((path) => byPath.has(path))) continue;
    for (const path of paths) {
      const row = rows.find((item) => item.path === path)!;
      row.status = 'blocked';
      row.reason = 'shared_episode';
    }
  }

  // The coverage that the title has after the correction. A request that a person must read keeps the old coverage.
  const coverage = new Map(rows.map((row) => [row.path, row.status === 'blocked' ? row.from : row.to]));
  const pointers: PointerRow[] = [];
  for (const episode of title.episodes) {
    const current = episode.fileId ? db.data.files[episode.fileId] : undefined;
    // A file that is gone keeps its pointer, so the episode shows as missing.
    if (current && !current.missing && covers(coverage.get(current.path) ?? [], episode)) continue;
    const next = files.find((file) => !file.missing && covers(coverage.get(file.path) ?? [], episode));
    if (current?.missing && !next && covers(coverage.get(current.path) ?? [], episode)) continue;
    if (episode.fileId !== (next?.id ?? null)) pointers.push({ season: episode.season, number: episode.number, from: current?.path ?? null, to: next?.path ?? null });
  }

  const lostAvailability = pointers.filter((pointer) => pointer.from && !pointer.to && files.some((file) => file.path === pointer.from && !file.missing)).map(({ season, number }) => ({ season, number }));
  const removed = pointers.filter((pointer) => pointer.from && !pointer.to);
  const continued: Correction['continued'] = [];
  const staysBlocked: Correction['staysBlocked'] = [];
  for (const entry of Object.values(db.data.queue).filter((entry) => entry.titleKey === titleKey).sort((a, b) => a.id.localeCompare(b.id))) {
    const approved = rows.some((row) => byPath.has(row.path) && row.reason === null && row.to.some((episode) => episode.season === entry.season && episode.number === entry.number));
    if (entry.state.kind === 'blocked' && ids.includes(entry.id) && approved && !rows.some((row) => row.status === 'blocked')) continued.push({ id: entry.id, phase: 'importing' });
    else if (entry.state.kind === 'blocked') staysBlocked.push({ id: entry.id, code: entry.state.problem.code });
    else if (entry.state.kind !== 'cancelled' && removed.some((episode) => episode.season === entry.season && episode.number === entry.number)) staysBlocked.push({ id: entry.id, code: 'file_unmapped' });
  }
  for (const episode of removed) {
    const id = entryId(titleKey, episode.season, episode.number);
    if (!db.data.queue[id]) staysBlocked.push({ id, code: 'file_unmapped' });
  }
  return { titleKey, entries, ids, version: versionOf(titleKey, entries, ids), rows, pointers, lostAvailability, continued, staysBlocked };
}

// Stores exact results for recovery. This function changes no data.
export function prepareCorrection(correction: Correction): CorrectionCommit {
  const title = db.data.titles[correction.titleKey];
  if (!title) throw new PlanError('title_not_found');
  if (correction.version !== versionOf(correction.titleKey, correction.entries, correction.ids)) throw new PlanError('mapping_stale');
  const current = correctionOf(correction.titleKey, correction.entries, correction.ids);
  if (current.rows.some((row) => row.status === 'blocked')) throw new PlanError('mapping_blocked');
  const requested = new Set(current.entries.map((entry) => entry.path));
  const files: CorrectionCommit['files'] = [];
  for (const row of current.rows) {
    const existing = row.fileId ? db.data.files[row.fileId] : undefined;
    if (!existing || row.reason || !requested.has(row.path)) continue;
    const file = structuredClone(existing);
    const identity = physicalOf(file) ?? { ...file.association?.identity, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs };
    file.episodes = row.to.map((episode) => ({ season: episode.season, number: episode.number }));
    file.sizeBytes = identity.sizeBytes;
    file.mtimeMs = identity.mtimeMs;
    file.association = {
      source: 'manual',
      originalName: file.association?.originalName ?? file.path,
      numberingRevision: title.numbering?.revision ?? 0,
      identity,
    };
    files.push(file);
  }
  const pointers = current.pointers.map((pointer) => {
    const file = pointer.to ? Object.values(db.data.files).find((item) => item.titleKey === title.key && item.path === pointer.to && !item.missing) : undefined;
    return { season: pointer.season, number: pointer.number, fileId: file?.id ?? null };
  });
  return structuredClone({ titleKey: title.key, ids: current.ids, files, pointers, numbering: title.numbering ?? { revision: 0, ranges: [] }, lostAvailability: current.lostAvailability, continued: current.continued });
}

// The intent reaches db.json before the library or queue changes.
export function correctionJournal(correction: CorrectionCommit): ImportJournal {
  const title = db.data.titles[correction.titleKey];
  if (!title) throw new PlanError('title_not_found');
  const root = db.data.roots[title.rootId];
  if (correction.continued.length && !root) throw new PlanError('root_unavailable');
  const steps: JournalStep[] = [];
  for (const continuation of correction.continued) {
    const entry = db.data.queue[continuation.id]!;
    const file = correction.files.find((item) => item.episodes.some((episode) => episode.season === entry.season && episode.number === entry.number))!;
    const existing = steps.find((step) => step.source === file.path);
    if (existing) existing.entryIds.push(entry.id);
    else steps.push({
      entryIds: [entry.id], source: file.path, dest: file.path, replaces: file.path, state: 'planned', method: null,
      sizeBytes: file.sizeBytes, episodes: file.episodes.map((item) => ({ ...item })), validation: 'basic',
      association: file.association ? { source: file.association.source, originalName: file.association.originalName, numberingRevision: file.association.numberingRevision } : undefined,
      sourceIdentity: file.association?.identity,
    });
  }
  const id = randomUUID();
  return { id, hash: `mapping:${id}`, titleKey: title.key, steps, createdAt: Date.now(), sourceBase: root?.path, correction: structuredClone(correction) };
}

// Replays only the stored result and target scope. Repeated recovery adds no second attempt.
export function commitCorrection(correction: CorrectionCommit, { queue }: ApplyDeps = {}): void {
  const title = db.data.titles[correction.titleKey];
  if (!title) throw new PlanError('title_not_found');
  for (const file of correction.files) {
    const saved = structuredClone(file);
    const expected = saved.association?.identity;
    const actual = physicalOf(saved);
    if (expected && actual !== undefined && (!actual || actual.sizeBytes === 0 || expected.sizeBytes !== actual.sizeBytes || expected.mtimeMs !== actual.mtimeMs || (expected.dev !== undefined && expected.dev !== actual.dev) || (expected.ino !== undefined && expected.ino !== actual.ino))) saved.missing = true;
    if (db.data.files[file.id]) Object.assign(db.data.files[file.id]!, saved);
    else db.data.files[file.id] = saved;
  }
  for (const pointer of correction.pointers) {
    const episode = title.episodes.find((item) => item.season === pointer.season && item.number === pointer.number);
    if (episode) episode.fileId = pointer.fileId;
  }
  if (queue) {
    for (const episode of correction.pointers.filter((pointer) => pointer.fileId === null)) {
      const entry = queue.ensure(title.key, episode.season, episode.number);
      if (entry.state.kind === 'cancelled') continue;
      if (entry.attempt === 0) queue.startAttempt(entry, 'mapping removed the file association');
      queue.invalidate(entry, 'mapping removed the file association');
    }
    for (const continuation of correction.continued) {
      const entry = queue.get(continuation.id);
      if (!entry || entry.state.kind === 'cancelled' || entry.state.kind === 'available' || entry.state.kind === 'paused') continue;
      const episode = title.episodes.find((item) => item.season === entry.season && item.number === entry.number);
      const file = episode?.fileId ? db.data.files[episode.fileId] : undefined;
      if (!file) continue;
      entry.manualMatch = { file: file.path, covers: file.episodes.map((item) => ({ ...item })) };
      entry.numbering = structuredClone(correction.numbering);
      if (entry.attempt === 0) queue.startAttempt(entry, 'mapping approved');
      queue.resolve(entry, 'importing', 'mapping approved', file.path);
    }
  }
}

// The importer calls this before normal journal execution, including after a restart.
export async function recoverCorrection(journal: ImportJournal, deps: ApplyDeps = {}): Promise<void> {
  if (!journal.correction) return;
  commitCorrection(journal.correction, deps);
  bindJournal(journal);
  await db.write();
  delete journal.correction;
  if (!journal.steps.length) delete db.data.imports[journal.id];
  await db.write();
}

// Synchronous callers save the database. The HTTP route persists an intent before this step.
export function applyCorrection(correction: Correction, deps: ApplyDeps = {}): void {
  const version = versionOf(correction.titleKey, correction.entries, correction.ids);
  if (applied.get(correction) === version) return;
  const prepared = prepareCorrection(correction);
  const journal = deps.queue ? correctionJournal(prepared) : undefined;
  commitCorrection(prepared, deps);
  if (journal?.steps.length) {
    bindJournal(journal);
    delete journal.correction;
    db.data.imports[journal.id] = journal;
    deps.enqueue?.({ type: 'import.run', payload: { hash: journal.hash }, dedupeKey: `import:${journal.hash}` });
  }
  applied.set(correction, versionOf(correction.titleKey, correction.entries, correction.ids));
}
