import { type ImportCheckId, IMPORT_CHECK_IDS } from '@ladarr/shared/enums';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile as fsCopyFile, link as fsLink, lstat, mkdir, readdir, realpath, rename as fsRename, rm, stat, statfs, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { type Db, type MediaFile, db } from '../../core/db.ts';
import type { Events } from '../../core/events.ts';
import { enqueue as enqueueJob, JobError } from '../../core/jobs.ts';
import type { Episode, Title } from '../library.ts';
import { catalog, itemFields, log } from '../../core/log.ts';
import type { ImportStatus } from './status.ts';
import { episodePath, folderName, moviePath } from '../naming.ts';
import { isSample, isVideoFile, parseEpisodes, titleNumbers } from '../parse.ts';
import { parseRelease } from '../grab/release.ts';
import { probeFile, type ProbeResult } from '../probe.ts';
import type { Clients } from '../downloads/client-api.ts';
import type { ClientHandle } from '../downloads/qbittorrent.ts';
import { ClientError } from '../downloads/qbittorrent.ts';
import { entryId, isActive, type Queue, type QueueEntry } from '../downloads/queue.ts';
import { checkRoot } from '../roots.ts';

// One file of an import. The steps of a file go in this order, and each step is saved before the next one starts:
// planned -> staged (a hard link or a copy next to the destination) -> published (the final name)
// -> committed (the library record) -> retired (the file that it replaced is gone).
export type JournalStep = {
  entryIds: string[];
  // The file in the download folder, relative to the download folder.
  source: string;
  // The new file, relative to the root of the title.
  dest: string;
  // The file that this one replaces, relative to the root of the title.
  replaces: string | null;
  state: 'planned' | 'staged' | 'published' | 'committed' | 'retired';
  method: 'hardlink' | 'copy' | null;
  sizeBytes: number;
  episodes: { season: number; number: number }[];
  validation: 'ffprobe' | 'basic';
};

// A journal of a download has the hash of the torrent, the client that has it, and the folder of the download (`downloadBase`). It has no `sourceBase`. The other journals have a folder as source:
// a manual import reads a folder that the user named, and a rename reads the root of the title (`kind: 'rename'`).
// An import from a download folder is link only: it never copies. It asks for a search when its files are in, so the
// episodes that it did not bring still get a release.
export type ImportJournal = { id: string; hash: string; titleKey: string; steps: JournalStep[]; createdAt: number; kind?: 'rename'; sourceBase?: string; clientId?: string; downloadBase?: string; linkOnly?: true; searchOnFinish?: true };

type Fs = { link: typeof fsLink; copyFile: typeof fsCopyFile; rename: typeof fsRename };

// The log line of each step of a file. The event is stable, and the message says what the step did.
const STEP_LOG: Record<JournalStep['state'], { event: string; message: string }> = {
  planned: { event: 'import_planned', message: 'Import planned' },
  staged: { event: 'import_staged', message: 'File staged in the folder of the title' },
  published: { event: 'import_published', message: 'File published with its final name' },
  committed: { event: 'import_committed', message: 'Library record updated' },
  retired: { event: 'import_retired', message: 'Replaced file removed' },
};

type Deps = {
  queue: Queue;
  events: Events;
  clients: Clients;
  save: () => Promise<void>;
  probe?: (path: string) => Promise<ProbeResult>;
  status?: ImportStatus;
  // How long a check stays in `running` before its work starts. Slow work keeps it there until it ends.
  checkDelayMs?: number;
  // For tests: replace a file operation, or stop after a step to test a restart.
  fs?: Partial<Fs>;
  afterStep?: (state: JournalStep['state'], step: JournalStep) => void | Promise<void>;
  now?: () => number;
};
export type ImportDeps = Deps;

// A problem that stops one import. It becomes the reason of the entry, and the other imports go on.
export class ImportProblem extends Error {
  code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

const MAX_DEPTH = 6;
const MAX_FILES = 5_000;
const MIN_FREE_BYTES = 50 * 1024 * 1024;
const BAD_ROOT = ['not_found', 'not_directory', 'not_readable', 'not_writable', 'mount_changed'];
const NO_LINK = new Set(['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP', 'EACCES', 'ENOSYS']);

export const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
export const posix = (path: string) => path.split(sep).join('/');
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code ?? '';

function problemOf(error: unknown): ImportProblem {
  if (error instanceof ImportProblem) return error;
  const code = errno(error);
  if (code === 'ENOSPC' || code === 'EDQUOT') return new ImportProblem('disk_full');
  if (['EACCES', 'EPERM', 'EROFS'].includes(code)) return new ImportProblem('permission_denied');
  return new ImportProblem('import_failed', code || 'unknown');
}

export type Found = { abs: string; rel: string; sizeBytes: number };

// Lists the video files in a download. It follows no link, and it skips samples.
// A folder that the user names can hold a staged file, so a manual import skips hidden names.
export async function listVideos(base: string, { skipHidden = false }: { skipHidden?: boolean } = {}): Promise<Found[]> {
  const info = await lstat(base);
  if (info.isFile()) return isVideoFile(base) ? [{ abs: base, rel: basename(base), sizeBytes: info.size }] : [];
  const found: Found[] = [];
  async function walk(dir: string, depth: number) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (found.length >= MAX_FILES) return;
      if (skipHidden && entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(abs, depth + 1);
      } else if (entry.isFile() && isVideoFile(entry.name) && !isSample(relative(base, abs))) {
        found.push({ abs, rel: posix(relative(base, abs)), sizeBytes: (await lstat(abs)).size });
      }
    }
  }
  await walk(base, 0);
  return found;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const checkKey = (hash: string, titleKey: string) => `${hash}:${titleKey}`;

export function createImporter({ queue, events, clients, save, probe = probeFile, status, checkDelayMs = 100, fs = {}, afterStep, now = Date.now }: Deps) {
  const ops: Fs = { link: fs.link ?? fsLink, copyFile: fs.copyFile ?? fsCopyFile, rename: fs.rename ?? fsRename };
  const wait = async () => {
    if (checkDelayMs > 0) await sleep(checkDelayMs);
  };

  const entriesOf = (ids: string[]) => ids.map((id) => queue.get(id)).filter((entry): entry is QueueEntry => Boolean(entry));
  const block = (entries: QueueEntry[], code: string, detail?: string) => {
    for (const entry of entries) {
      if (entry.replaceDestination) {
        entry.replaceDestination = undefined;
        queue.touch(entry);
      }
      catalog.warn('import_blocked', `Import blocked: ${code}${detail ? ` (${detail})` : ''}`, itemFields(entry), { code, detail: detail ?? null });
      queue.endAttempt(entry, 'failed', code);
      queue.move(entry, { reason: { code, ...(detail ? { detail } : {}) } }, 'import blocked', code);
    }
  };

  // A pack can leave episodes without a file. Those targets go back to the search at once, so a missing episode of
  // the pack does not wait for a user action or a later verification.
  const uncovered = (entries: QueueEntry[]) => {
    for (const entry of entries) {
      catalog.warn('import_uncovered', 'The download does not cover this episode. The search starts again.', itemFields(entry), { code: 'file_not_found' });
      queue.endAttempt(entry, 'failed', 'file_not_found');
      entry.release = null;
      entry.transferHash = null;
      entry.clientId = null;
      entry.search = null;
      entry.importResult = null;
      entry.replaceDestination = undefined;
      // The target starts a new try when the first search starts after this import.
      entry.attempt = 0;
      queue.move(entry, { stage: 'queued', branch: null, reason: null }, 'the pack does not cover the episode', 'file_not_found');
    }
  };

  // --- Plan -------------------------------------------------------------------------------

  type Pick = { file: Found; entries: QueueEntry[]; episodes: Episode[] };

  function pick(title: Title, group: QueueEntry[], files: Found[]): { picks: Pick[]; missing: QueueEntry[] } {
    const picks: Pick[] = [];
    const taken = new Set<string>();
    const episodeOf = (entry: QueueEntry) => title.episodes.find((e) => e.season === entry.season && e.number === entry.number);

    if (title.mediaType === 'movie') {
      const entry = group[0]!;
      const chosen = (entry.manualMatch && files.find((file) => file.rel === entry.manualMatch!.file)) ?? [...files].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
      return chosen ? { picks: [{ file: chosen, entries: [entry], episodes: [] }], missing: [] } : { picks, missing: group };
    }

    // A match that the user made comes first. It survives a retry.
    for (const entry of group) {
      const manual = entry.manualMatch;
      const file = manual && files.find((item) => item.rel === manual.file);
      if (!manual || !file || taken.has(file.rel)) continue;
      const covered = group.filter((other) => manual.covers.some((c) => c.season === other.season && c.number === other.number));
      picks.push({ file, entries: covered, episodes: covered.map(episodeOf).filter((e): e is Episode => Boolean(e)) });
      taken.add(file.rel);
    }
    const done = () => new Set(picks.flatMap((p) => p.entries.map((e) => e.id)));
    for (const file of [...files].sort((a, b) => b.sizeBytes - a.sizeBytes)) {
      if (taken.has(file.rel)) continue;
      const parsed = parseEpisodes(basename(file.rel)) ?? parseEpisodes(file.rel);
      if (!parsed) continue;
      const numbers = titleNumbers(parsed, title.episodes);
      const covered = group.filter((entry) => entry.season === parsed.season && numbers.includes(entry.number!) && !done().has(entry.id));
      // A file for an episode that was not asked for is part of the pack. It is not imported.
      if (!covered.length) continue;
      picks.push({ file, entries: covered, episodes: covered.map(episodeOf).filter((e): e is Episode => Boolean(e)) });
      taken.add(file.rel);
    }
    const left = group.filter((entry) => !done().has(entry.id));
    // A release for one episode with a name that gives no number: the one video is the episode.
    const loose = files.filter((file) => !taken.has(file.rel));
    if (left.length === 1 && group.length === 1 && loose.length === 1) {
      picks.push({ file: loose[0]!, entries: left, episodes: [episodeOf(left[0]!)].filter((e): e is Episode => Boolean(e)) });
      return { picks, missing: [] };
    }
    return { picks, missing: left };
  }

  async function plan(hash: string, group: QueueEntry[], handle: ClientHandle): Promise<ImportJournal | undefined> {
    const existing = db.data.titles[group[0]!.titleKey];
    // A manual import or a rename of this title is open. Its names are not in the library records yet, so the plan would see a taken name.
    // The targets stay in Validating, and the next poll of the client asks for a new run.
    if (existing && Object.values(db.data.imports).some((journal) => journal.titleKey === existing.key && journal.sourceBase)) return;

    const key = checkKey(hash, group[0]!.titleKey);
    status?.startChecks(key, group.map((entry) => entry.id), IMPORT_CHECK_IDS);

    const failureOf = (problem: ImportProblem) => ({ code: problem.code, ...(problem.message === problem.code ? {} : { detail: problem.message }) });
    const failGroup = (problem: ImportProblem) => block(group, problem.code, problem.message === problem.code ? undefined : problem.message);

    // Runs one check and keeps its reason when it fails.
    const run = async <T>(id: ImportCheckId, work: () => Promise<T>): Promise<T> => {
      status?.setCheck(key, id, 'running');
      await wait();
      try {
        const value = await work();
        status?.setCheck(key, id, 'ok');
        return value;
      } catch (error) {
        const problem = problemOf(error);
        status?.setCheck(key, id, 'failed', failureOf(problem));
        throw problem;
      }
    };
    // Runs one check of the whole group. A failed check blocks every target of the group and stops the plan.
    const checked = async <T>(id: ImportCheckId, work: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run(id, work);
      } catch (error) {
        failGroup(problemOf(error));
        return undefined;
      }
    };

    // The download is complete while the target is still in Validating. Only then does it move to Importing.
    status?.setCheck(key, 'download_complete', 'running');
    await wait();
    const torrent = await handle.api.find(hash);
    if (!torrent) {
      status?.setCheck(key, 'download_complete', 'failed', { code: 'torrent_missing' });
      block(group, 'torrent_missing');
      return;
    }
    if (!torrent.complete) {
      // The client has not finished. The target waits in Validating, and the next poll starts a new run.
      status?.setCheck(key, 'download_complete', 'pending');
      return;
    }
    status?.setCheck(key, 'download_complete', 'ok');

    // Checks 2-15 belong to Importing. Every target of the group moves there before the first one.
    for (const entry of group) queue.move(entry, { stage: 'importing', branch: null, reason: null }, 'import started');
    status?.publishChecks(key);

    const found = await checked('title_folder', async () => {
      const title = db.data.titles[group[0]!.titleKey];
      const root = title && db.data.roots[title.rootId];
      if (!title || !root) throw new ImportProblem('title_unavailable');
      return { title, root };
    });
    if (!found) return;
    const { title, root } = found;

    const health = await checked('root_available', async () => {
      const result = await checkRoot(root.path, root.dev);
      if (result.problems.some((problem) => BAD_ROOT.includes(problem))) throw new ImportProblem('root_unavailable');
      return result;
    });
    if (!health) return;

    const clientTorrent = await checked('download_in_client', async () => torrent);
    if (!clientTorrent) return;

    // The client says where the download is. ladarr must see the same path. It must lead into the save folder of the torrent, also after links are resolved.
    const paths = await checked('download_readable', async () => {
      const save = await realpath(clientTorrent.savePath).catch(() => undefined);
      const content = await realpath(clientTorrent.contentPath).catch(() => undefined);
      if (!save || !content) throw new ImportProblem('download_not_found');
      return { base: save, content };
    });
    if (!paths) return;
    const { base, content } = paths;

    const leads = await checked('download_inside', async () => {
      if (!inside(base, content)) throw new ImportProblem('path_outside_downloads');
      return true;
    });
    if (!leads) return;

    let picked: { picks: Pick[]; missing: QueueEntry[] };
    try {
      picked = await run('files_found', async () => {
        const files = await listVideos(content);
        const result = pick(title, group, files);
        if (!result.picks.length) throw new ImportProblem('file_not_found');
        return result;
      });
    } catch (error) {
      failGroup(problemOf(error));
      return;
    }
    // A pack with some files leaves the other episodes to a new search. A torrent with no usable file blocks, because
    // another search would only find the same torrent.
    if (picked.missing.length) uncovered(picked.missing);

    type Candidate = Pick & { dest: string | null; replaces: string | null; validation: 'ffprobe' | 'basic'; failed: boolean };
    const candidates: Candidate[] = picked.picks.map((item) => ({ ...item, dest: null, replaces: null, validation: 'basic', failed: false }));
    const alive = () => candidates.filter((candidate) => !candidate.failed);

    // Runs a check for each file. A file that fails is blocked here, and the other files go on.
    const perFile = async (id: ImportCheckId, work: (candidate: Candidate) => Promise<void>) => {
      status?.setCheck(key, id, 'running');
      await wait();
      let failure: ImportProblem | undefined;
      for (const candidate of alive()) {
        try {
          await work(candidate);
        } catch (error) {
          const problem = problemOf(error);
          candidate.failed = true;
          failure ??= problem;
          block(candidate.entries, problem.code, problem.message === problem.code ? undefined : problem.message);
        }
      }
      status?.setCheck(key, id, failure ? 'failed' : 'ok', failure ? failureOf(failure) : undefined);
      return alive().length > 0;
    };

    let rootReal: string | undefined;
    const folder = title.folder ?? folderName(title);
    const destinations = await perFile('destination_inside', async (candidate) => {
      rootReal ??= await realpath(root.path);
      const extension = extname(candidate.file.abs).toLowerCase();
      const dest = title.mediaType === 'movie' ? moviePath(title, folder, extension, db.data.settings.naming) : episodePath(title, folder, candidate.episodes, extension, db.data.settings.naming);
      if (!inside(rootReal, join(rootReal, dest))) throw new ImportProblem('destination_outside_root');
      candidate.dest = dest;
    });
    if (!destinations || !rootReal) return;

    const readable = await perFile('file_readable', async (candidate) => {
      const result = await probe(candidate.file.abs);
      if (result.ok === false) throw new ImportProblem('file_unreadable', result.reason);
      // Without ffprobe the check is basic: the file has data. A health problem tells the user.
      if (result.ok === 'skipped' && candidate.file.sizeBytes === 0) throw new ImportProblem('file_unreadable', 'empty');
      candidate.validation = result.ok === true ? 'ffprobe' : 'basic';
    });
    if (!readable) return;

    const free = await perFile('destination_free', async (candidate) => {
      const dest = candidate.dest!;
      const known = title.mediaType === 'movie' ? title.fileId : candidate.episodes.map((e) => e.fileId).find(Boolean);
      const old = known ? db.data.files[known] : undefined;
      const target = await lstat(join(rootReal!, dest)).catch(() => undefined);
      // A file at the destination is safe to replace only when it is the file that the library has for this target.
      if (target && !(old && old.path === dest && !old.missing)) {
        // The user chose to replace the file that holds the name. A folder is never removed.
        const replace = candidate.entries.some((entry) => entry.replaceDestination);
        if (!replace || target.isDirectory()) throw new ImportProblem('destination_exists', dest);
        await unlink(join(rootReal!, dest));
      }
      candidate.replaces = old && !old.missing ? old.path : null;
    });
    if (!free) return;

    status?.setCheck(key, 'names_unique', 'running');
    await wait();
    const built = alive();
    const names = new Map<string, number>();
    for (const candidate of built) if (candidate.dest) names.set(candidate.dest, (names.get(candidate.dest) ?? 0) + 1);
    const duplicates = built.filter((candidate) => candidate.dest !== null && (names.get(candidate.dest) ?? 0) > 1);
    // Two files can not share a destination. The check covers every built step, so a duplicate stops the whole import.
    if (duplicates.length) for (const candidate of built) candidate.failed = true;
    if (duplicates.length) block(built.flatMap((candidate) => candidate.entries), 'destination_exists');
    status?.setCheck(key, 'names_unique', duplicates.length ? 'failed' : 'ok', duplicates.length ? { code: 'destination_exists' } : undefined);
    if (!alive().length) return;

    const steps: JournalStep[] = alive().map((candidate) => ({
      entryIds: candidate.entries.map((e) => e.id),
      source: posix(relative(base, candidate.file.abs)),
      dest: candidate.dest!,
      replaces: candidate.replaces,
      state: 'planned',
      method: null,
      sizeBytes: candidate.file.sizeBytes,
      episodes: candidate.episodes.map((e) => ({ season: e.season, number: e.number })),
      validation: candidate.validation,
    }));
    if (!steps.length) return;

    const journal: ImportJournal = { id: randomUUID(), hash, titleKey: title.key, steps, createdAt: now(), clientId: handle.id, downloadBase: base };
    db.data.imports[journal.id] = journal;
    for (const step of steps) {
      for (const entry of entriesOf(step.entryIds)) {
        catalog.info('import_started', `Import started with ${steps.length} ${steps.length === 1 ? 'file' : 'files'}`, itemFields(entry), { files: steps.length, hash });
        catalog.info('import_planned', STEP_LOG.planned.message, itemFields(entry), {
          state: step.state,
          source: step.source,
          dest: step.dest,
          method: step.method,
          sizeBytes: step.sizeBytes,
          validation: step.validation,
          replaces: step.replaces,
          episodes: step.episodes.length,
        });
      }
    }
    await save();
    return journal;
  }

  // --- Execute ----------------------------------------------------------------------------

  async function stage(journal: ImportJournal, step: JournalStep, rootReal: string, base: string) {
    const dest = join(rootReal, step.dest);
    const stagePath = join(dirname(dest), `.ladarr-${journal.id.slice(0, 8)}-${basename(dest)}`);
    await mkdir(dirname(dest), { recursive: true });
    // The folders were just made. They must be inside the root, also after links are resolved.
    if (!inside(rootReal, await realpath(dirname(dest)))) throw new ImportProblem('destination_outside_root');
    const source = join(base, step.source);
    await rm(stagePath, { force: true });
    try {
      await ops.link(source, stagePath);
      step.method = 'hardlink';
    } catch (error) {
      if (!NO_LINK.has(errno(error))) throw error;
      // A rename of a big file must not become a copy. The file keeps its name.
      // An import from a download folder must not copy either: the user asked for a link.
      if (journal.kind === 'rename' || journal.linkOnly) throw new ImportProblem('hard_link_unavailable');
      // No hard link here. The copy needs room, and it leaves the source as it is.
      const space = await statfs(dirname(dest));
      if (Number(space.bavail) * Number(space.bsize) < step.sizeBytes + MIN_FREE_BYTES) throw new ImportProblem('disk_full');
      const stop = status?.watchCopy(journal.id, step.dest, step.entryIds, stagePath, step.sizeBytes);
      try {
        await ops.copyFile(source, stagePath, constants.COPYFILE_EXCL);
      } finally {
        stop?.();
      }
      step.method = 'copy';
      if ((await stat(stagePath)).size !== step.sizeBytes) throw new ImportProblem('copy_incomplete');
    }
    return stagePath;
  }

  const stagePathOf = (journal: ImportJournal, step: JournalStep, rootReal: string) => join(dirname(join(rootReal, step.dest)), `.ladarr-${journal.id.slice(0, 8)}-${basename(step.dest)}`);

  async function publish(journal: ImportJournal, step: JournalStep, rootReal: string) {
    const dest = join(rootReal, step.dest);
    const stagePath = stagePathOf(journal, step, rootReal);
    if (step.replaces === step.dest) {
      // The same name: replace the old data in one step.
      await ops.rename(stagePath, dest);
      return;
    }
    try {
      // A link fails when the name exists. A rename would replace the file of someone else.
      await ops.link(stagePath, dest);
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
      // A restart after the link and before the save: the destination is the staged file already.
      const [a, b] = await Promise.all([stat(stagePath), stat(dest)]);
      if (a.ino !== b.ino || a.dev !== b.dev) throw new ImportProblem('destination_exists');
    }
    await unlink(stagePath).catch(() => {});
  }

  // A rename keeps the library record of the file. Only its path changes.
  async function commitRename(journal: ImportJournal, step: JournalStep, rootReal: string) {
    const info = await stat(join(rootReal, step.dest));
    // No await from here, so the record changes in one step. A restart can find the record at the new path already.
    const file = Object.values(db.data.files).find((item) => item.titleKey === journal.titleKey && (item.path === step.replaces || item.path === step.dest));
    if (file) Object.assign(file, { path: step.dest, sizeBytes: info.size, mtimeMs: info.mtimeMs, missing: false });
    step.state = 'committed';
  }

  // A target that waits for a release, or that has an import problem, is done when the user adds its file by hand.
  // A target that has a download in work keeps it.
  function settleQueue(title: Title, step: JournalStep) {
    const ids = title.mediaType === 'movie' ? [title.key] : step.episodes.map((c) => entryId(title.key, c.season, c.number));
    for (const entry of ids.map((id) => queue.get(id))) {
      if (!entry || entry.attempt === 0 || !isActive(entry) || entry.branch === 'paused') continue;
      // A download import that stopped on a problem leaves its target in Validating or in Importing with a block. Its journal has ended.
      if (!(entry.stage === 'queued' || entry.stage === 'searching' || ((entry.stage === 'validating' || entry.stage === 'importing') && entry.reason !== null))) continue;
      queue.endAttempt(entry, 'imported', 'imported by hand');
      entry.importResult = { at: now(), ok: true, method: step.method, path: step.dest, validation: step.validation };
      catalog.info('import_completed', `Import completed by hand: ${step.dest}`, itemFields(entry), { path: step.dest, method: step.method, validation: step.validation, manual: true });
      queue.move(entry, { stage: 'available', branch: null, reason: null }, 'imported by hand', step.method ?? undefined);
    }
  }

  async function commit(journal: ImportJournal, step: JournalStep, rootReal: string) {
    if (journal.kind === 'rename') return commitRename(journal, step, rootReal);
    const info = await stat(join(rootReal, step.dest));
    // No await from here, so the library record and the queue change in one step.
    const title = db.data.titles[journal.titleKey];
    if (!title) return;
    const existing = Object.values(db.data.files).find((file) => file.titleKey === title.key && file.path === step.dest);
    const file: MediaFile = existing ?? { id: randomUUID(), titleKey: title.key, path: step.dest, sizeBytes: info.size, mtimeMs: info.mtimeMs, episodes: step.episodes, missing: false, addedAt: now() };
    // The source and the resolution of the release go with the file, so a later upgrade knows what the file is.
    const release = entriesOf(step.entryIds).find((entry) => entry.release)?.release;
    const parsed = release ? parseRelease(release.title) : null;
    Object.assign(file, { sizeBytes: info.size, mtimeMs: info.mtimeMs, episodes: step.episodes, missing: false, source: parsed?.source ?? null, resolution: parsed?.resolution ?? null });
    db.data.files[file.id] = file;

    const covered = title.mediaType === 'movie' ? [] : step.episodes.map((c) => title.episodes.find((e) => e.season === c.season && e.number === c.number)).filter((e): e is Episode => Boolean(e));
    const previous = new Set<string>();
    if (title.mediaType === 'movie') {
      if (title.fileId && title.fileId !== file.id) previous.add(title.fileId);
      title.fileId = file.id;
    } else {
      for (const episode of covered) {
        if (episode.fileId && episode.fileId !== file.id) previous.add(episode.fileId);
        episode.fileId = file.id;
      }
    }
    // The old record goes when no episode points to it. Its file is removed or already gone.
    for (const id of previous) {
      const stillUsed = title.fileId === id || title.episodes.some((e) => e.fileId === id);
      if (!stillUsed) delete db.data.files[id];
    }
    title.folder ??= step.dest.split('/')[0]!;
    if (journal.sourceBase) settleQueue(title, step);
    for (const entry of entriesOf(step.entryIds)) {
      entry.importResult = { at: now(), ok: true, method: step.method, path: step.dest, validation: step.validation };
      if (entry.replaceDestination) {
        entry.replaceDestination = undefined;
        queue.touch(entry);
      }
      // A download import moves its targets to Available after every step is retired. A manual import and a rename
      // finish each target here.
      if (!journal.sourceBase) continue;
      catalog.info('import_completed', `Import completed: ${step.dest}`, itemFields(entry), { path: step.dest, method: step.method, validation: step.validation });
      queue.endAttempt(entry, 'imported');
      queue.move(entry, { stage: 'available', branch: null, reason: null }, 'imported', step.method ?? undefined);
    }
    step.state = 'committed';
  }

  // The new name is the same data as the old name. The old name goes, but only when it is still that data.
  async function retireRename(step: JournalStep, rootReal: string) {
    const [old, current] = [join(rootReal, step.replaces!), join(rootReal, step.dest)];
    const [a, b, same] = await Promise.all([lstat(old).catch(() => undefined), stat(current), realpath(old).then(async (path) => path === (await realpath(current)), () => false)]);
    // A file system that ignores letter case can give both names to one entry. Then the old name must stay.
    if (a?.isFile() && !same && a.ino === b.ino && a.dev === b.dev) await unlink(old);
    step.state = 'retired';
  }

  async function retire(journal: ImportJournal, step: JournalStep, rootReal: string) {
    if (journal.kind === 'rename') return retireRename(step, rootReal);
    // A replaced file with another name is removed. The same name was replaced at publish.
    if (step.replaces && step.replaces !== step.dest) {
      await unlink(join(rootReal, step.replaces)).catch((error) => {
        if (errno(error) !== 'ENOENT') throw error;
      });
    }
    step.state = 'retired';
  }

  // A file of a manual import did not pass the check of a download. It is read here, in the worker, so the request of the user stays short.
  async function checkSource(step: JournalStep, base: string) {
    const result = await probe(join(base, step.source));
    if (result.ok === false) throw new ImportProblem('file_unreadable', result.reason);
    if (result.ok === 'skipped' && step.sizeBytes === 0) throw new ImportProblem('file_unreadable', 'empty');
    step.validation = result.ok === true ? 'ffprobe' : 'basic';
  }

  // A download import moves its targets to Available only when every step is retired. Until then they stay in
  // Importing, and every target of the group shows the same check list.
  function finishDownload(journal: ImportJournal) {
    const done = new Set<string>();
    for (const step of journal.steps) {
      for (const entry of entriesOf(step.entryIds)) {
        if (done.has(entry.id)) continue;
        done.add(entry.id);
        entry.importResult = { at: now(), ok: true, method: step.method, path: step.dest, validation: step.validation };
        catalog.info('import_completed', `Import completed: ${step.dest}`, itemFields(entry), { path: step.dest, method: step.method, validation: step.validation });
        queue.endAttempt(entry, 'imported');
        queue.move(entry, { stage: 'available', branch: null, reason: null }, 'imported', step.method ?? undefined);
      }
    }
  }

  // Moves each step forward from the state that it has. A restart calls this again, so every state can start from itself.
  async function execute(journal: ImportJournal) {
    const title = db.data.titles[journal.titleKey];
    const root = title && db.data.roots[title.rootId];
    // The title left the library while a manual import or a rename was open. Nothing can commit, so the journal ends.
    if ((!title || !root) && journal.sourceBase) {
      delete db.data.imports[journal.id];
      await save();
      status?.finish(journal.id);
      return;
    }
    const base = journal.sourceBase ?? journal.downloadBase;
    if (!title || !root || !base) return;
    // A manual import and a rename read files that the library has. The root must be the one that the user accepted.
    if (journal.sourceBase && (await checkRoot(root.path, root.dev)).problems.some((problem) => BAD_ROOT.includes(problem))) throw new JobError('outage', 'root_unavailable');
    const rootReal = await realpath(root.path);
    // The hook of a test stands for a crash. A crash is not a problem of the import, so it goes up as it is.
    let crash: unknown;
    const after = async (state: JournalStep['state'], step: JournalStep) => {
      try {
        await afterStep?.(state, step);
      } catch (error) {
        crash = error;
        throw error;
      }
    };

    // The queue shows the step and the method of an open import. A change of the step is a change of the entry, and a
    // line in the log of each item.
    const shown = (step: JournalStep) => {
      const info = STEP_LOG[step.state];
      for (const entry of entriesOf(step.entryIds)) {
        queue.touch(entry);
        catalog.info(info.event, info.message, itemFields(entry), {
          state: step.state,
          source: step.source,
          dest: step.dest,
          method: step.method,
          sizeBytes: step.sizeBytes,
          validation: step.validation,
          replaces: step.replaces,
          episodes: step.episodes.length,
        });
      }
    };

    // A step that fails before the library record is in the journal goes out, and its targets are blocked. The other
    // steps of the import go on. A failure after the record cannot be undone, so it goes up as it is.
    const failed = async (step: JournalStep, error: unknown): Promise<ImportProblem> => {
      const problem = problemOf(error);
      if (step.state !== 'planned' && step.state !== 'staged' && step.state !== 'published') throw error;
      // Nothing is in the library yet. Remove the staged file. The old library file was not changed.
      await rm(stagePathOf(journal, step, rootReal), { force: true }).catch(() => {});
      block(entriesOf(step.entryIds), problem.code, problem.message === problem.code ? undefined : problem.message);
      journal.steps = journal.steps.filter((other) => other !== step);
      status?.problem(journal.id, step.source, problem.code, problem.message === problem.code ? undefined : problem.message);
      const affected = entriesOf(step.entryIds);
      if (affected.length) {
        for (const entry of affected) catalog.warn('import_failed', `Import failed: ${problem.code} (${step.source})`, itemFields(entry), { code: problem.code, state: step.state, file: step.source, dest: step.dest });
      } else log.warn('import step failed', { code: problem.code, state: step.state });
      return problem;
    };

    if (journal.sourceBase) {
      for (const step of [...journal.steps]) {
        try {
          if (step.state === 'planned') {
            if (journal.kind !== 'rename') await checkSource(step, base);
            await stage(journal, step, rootReal, base);
            step.state = 'staged';
            await save();
            shown(step);
            await after('staged', step);
          }
          if (step.state === 'staged') {
            // The staged file must be there and whole. If not, the step starts again.
            const staged = await stat(stagePathOf(journal, step, rootReal)).catch(() => undefined);
            const published = await stat(join(rootReal, step.dest)).catch(() => undefined);
            if (!staged && !(published && published.size === step.sizeBytes)) {
              step.state = 'planned';
              await stage(journal, step, rootReal, base);
              step.state = 'staged';
            } else if (staged && staged.size !== step.sizeBytes) throw new ImportProblem('copy_incomplete');
            if (staged) await publish(journal, step, rootReal);
            step.state = 'published';
            await save();
            shown(step);
            await after('published', step);
          }
          if (step.state === 'published') {
            await commit(journal, step, rootReal);
            await save();
            shown(step);
            await after('committed', step);
          }
          if (step.state === 'committed') {
            await retire(journal, step, rootReal);
            await save();
            shown(step);
            status?.stepDone(journal.id);
            await after('retired', step);
          }
        } catch (error) {
          if (error === crash) throw error;
          await failed(step, error);
        }
      }
    } else {
      const key = checkKey(journal.hash, journal.titleKey);
      // Each phase runs for every step that still has work in it. A step that fails leaves the journal, and the phase
      // keeps its reason.
      const phase = async (id: ImportCheckId, advance: (step: JournalStep) => Promise<void>) => {
        status?.setCheck(key, id, 'running');
        await wait();
        let failure: ImportProblem | undefined;
        for (const step of [...journal.steps]) {
          try {
            await advance(step);
          } catch (error) {
            if (error === crash) throw error;
            failure ??= await failed(step, error);
          }
        }
        status?.setCheck(key, id, failure ? 'failed' : 'ok', failure ? { code: failure.code, ...(failure.message === failure.code ? {} : { detail: failure.message }) } : undefined);
      };

      await phase('staged', async (step) => {
        if (step.state !== 'planned') return;
        await stage(journal, step, rootReal, base);
        step.state = 'staged';
        await save();
        shown(step);
        await after('staged', step);
      });
      if (journal.steps.length) {
        await phase('published', async (step) => {
          if (step.state !== 'staged') return;
          // The staged file must be there and whole. If not, the step starts again.
          const staged = await stat(stagePathOf(journal, step, rootReal)).catch(() => undefined);
          const published = await stat(join(rootReal, step.dest)).catch(() => undefined);
          if (!staged && !(published && published.size === step.sizeBytes)) {
            step.state = 'planned';
            await stage(journal, step, rootReal, base);
            step.state = 'staged';
          } else if (staged && staged.size !== step.sizeBytes) throw new ImportProblem('copy_incomplete');
          if (staged) await publish(journal, step, rootReal);
          step.state = 'published';
          await save();
          shown(step);
          await after('published', step);
        });
      }
      if (journal.steps.length) {
        await phase('committed', async (step) => {
          if (step.state !== 'published') return;
          await commit(journal, step, rootReal);
          await save();
          shown(step);
          await after('committed', step);
        });
      }
      if (journal.steps.length) {
        await phase('retired', async (step) => {
          if (step.state !== 'committed') return;
          await retire(journal, step, rootReal);
          await save();
          shown(step);
          status?.stepDone(journal.id);
          await after('retired', step);
        });
      }
    }
    if (journal.steps.every((step) => step.state === 'retired') || !journal.steps.length) {
      if (!journal.sourceBase) finishDownload(journal);
      delete db.data.imports[journal.id];
      // The files are in, so a search only targets the episodes that have no file. A download import runs it too:
      // a pack can leave episodes without a file, and they must not wait for another action.
      if (journal.searchOnFinish || !journal.sourceBase) enqueueJob({ type: 'queue.initial', payload: { key: journal.titleKey }, dedupeKey: `initial:${journal.titleKey}` });
      await save();
      status?.finish(journal.id);
    }
    events.publish('library.changed', { key: journal.titleKey });
  }

  async function run(hash: string) {
    // A journal from an earlier run comes first, so an interrupted import ends before a new one starts.
    for (const journal of Object.values(db.data.imports).filter((item) => item.hash === hash)) await execute(journal);

    const inJournal = new Set(Object.values(db.data.imports).flatMap((journal) => journal.steps.flatMap((step) => step.entryIds)));
    const ready = Object.values(db.data.queue).filter((entry) => entry.transferHash === hash && ['validating', 'importing'].includes(entry.stage) && !entry.branch && !entry.reason && !inJournal.has(entry.id));
    // The targets of one torrent have the same client.
    const handle = clients.get(ready[0]?.clientId);
    if (!handle) return;
    const byTitle = new Map<string, QueueEntry[]>();
    for (const entry of ready) byTitle.set(entry.titleKey, [...(byTitle.get(entry.titleKey) ?? []), entry]);
    for (const group of byTitle.values()) {
      let journal: ImportJournal | undefined;
      try {
        journal = await plan(hash, group, handle);
      } catch (error) {
        if (error instanceof ClientError) throw error;
        const problem = problemOf(error);
        block(group, problem.code);
        continue;
      }
      if (journal) await execute(journal);
    }
  }

  // --- Jobs -------------------------------------------------------------------------------

  return { run };
}

// The IDs of the downloads that have an unfinished import, so a start of the server can finish them. A target in
// Validating or Importing with a torrent is unfinished too, also when no journal was written.
export const unfinishedImports = () => {
  const hashes = new Set(Object.values(db.data.imports).map((journal) => journal.hash));
  for (const entry of Object.values(db.data.queue)) {
    if (!entry.transferHash || entry.branch === 'cancelled') continue;
    if (entry.stage === 'validating' || entry.stage === 'importing') hashes.add(entry.transferHash);
  }
  return [...hashes];
};

// The video files of a download, for the "Match file" choice. Returns nothing when the download is not reachable.
export async function listDownloadFiles(handle: ClientHandle, hash: string): Promise<{ rel: string; sizeBytes: number }[] | undefined> {
  const torrent = await handle.api.find(hash);
  const base = torrent && (await realpath(torrent.savePath).catch(() => undefined));
  const content = torrent && (await realpath(torrent.contentPath).catch(() => undefined));
  if (!base || !content || !inside(base, content)) return;
  return (await listVideos(content)).map(({ rel, sizeBytes }) => ({ rel, sizeBytes }));
}
