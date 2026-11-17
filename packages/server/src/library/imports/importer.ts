import { type ImportCheckId, IMPORT_CHECK_IDS } from '@ladarr/shared/enums';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile as fsCopyFile, link as fsLink, lstat, mkdir, readdir, realpath, rename as fsRename, rm, stat, statfs, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { db } from '../../core/db.ts';
import { enqueue as enqueueJob, JobError } from '../../core/jobs.ts';
import { catalog, itemFields, log } from '../../core/log.ts';
import { episodePath, folderName, moviePath, versionedPath } from '../naming.ts';
import { isSample, isVideoFile, parseEpisodes } from '../parse.ts';
import { evidenceOf, matchContent } from '../content.ts';
import { inspectCoverage } from '../coverage.ts';
import { recoverCorrection } from '../mapping.ts';
import { parseRelease } from '../grab/release.ts';
import { probeFile } from '../probe.ts';
import { ClientError } from '../downloads/qbittorrent.ts';
import { entryId, isActive, phaseOfEntry } from '../downloads/queue.ts';
import { checkRoot } from '../roots.ts';
import { MAX_IMPORT_ATTEMPTS } from './limits.ts';
import type { ClientHandle, Episode, Fs, ImporterDeps, ImporterFound, ImportJournal, JournalStep, MediaFile, ProbeResult, QueueEntry, Title, Torrent } from '../../types.ts';

// The log line of each step of a file. The event is stable, and the message says what the step did.
const STEP_LOG: Record<JournalStep['state'], { event: string; message: string }> = {
  planned: { event: 'import_planned', message: 'Import planned' },
  staged: { event: 'import_staged', message: 'File staged in the folder of the title' },
  published: { event: 'import_published', message: 'File published with its final name' },
  committed: { event: 'import_committed', message: 'Library record updated' },
  retired: { event: 'import_retired', message: 'Replaced file removed' },
};

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

// Lists the video files in a download. It follows no link, and it skips samples.
// A folder that the user names can hold a staged file, so a manual import skips hidden names.
export async function listVideos(base: string, { skipHidden = false }: { skipHidden?: boolean } = {}): Promise<ImporterFound[]> {
  const info = await lstat(base);
  if (info.isFile()) return isVideoFile(base) ? [{ abs: base, rel: basename(base), sizeBytes: info.size }] : [];
  const found: ImporterFound[] = [];
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

// The video files of a torrent, from the file list of the client. The folder of the content can be the folder of every
// download, so the disk is not walked.
export async function torrentVideos(handle: ClientHandle, torrent: Torrent): Promise<ImporterFound[] | undefined> {
  const save = await realpath(torrent.savePath).catch(() => undefined);
  const content = await realpath(torrent.contentPath).catch(() => undefined);
  if (!save || !content || !inside(save, content)) return;
  const found: ImporterFound[] = [];
  for (const file of await handle.api.files(torrent.hash)) {
    const abs = join(save, file.name);
    if (!inside(save, abs) || !inside(content, abs)) continue;
    const rel = abs === content ? basename(abs) : posix(relative(content, abs));
    if (!isVideoFile(rel) || isSample(rel)) continue;
    const info = await lstat(abs).catch(() => undefined);
    if (!info?.isFile()) continue;
    found.push({ abs, rel, sizeBytes: info.size });
  }
  return found;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const checkKey = (hash: string, titleKey: string) => `${hash}:${titleKey}`;
class StaleImport extends Error {}
const sameIdentity = (expected: NonNullable<JournalStep['sourceIdentity']>, actual: { size: number; mtimeMs: number; dev: number; ino: number }) =>
  expected.sizeBytes === actual.size && expected.mtimeMs === actual.mtimeMs && (expected.dev === undefined || expected.dev === actual.dev) && (expected.ino === undefined || expected.ino === actual.ino);

const numberingOf = (entry: QueueEntry) => entry.numbering === undefined ? db.data.titles[entry.titleKey]?.numbering ?? null : entry.numbering;
const assignmentsOf = (entry: QueueEntry) => {
  const assignments = new Map<string, { file: string; covers: { season: number; number: number }[]; revision: number }>();
  if (db.data.titles[entry.titleKey]?.mediaType !== 'tv') return [];
  for (const other of Object.values(db.data.queue)) {
    if (other.titleKey !== entry.titleKey || other.clientId !== entry.clientId || other.transferHash !== entry.transferHash || !other.manualMatch) continue;
    const match = other.manualMatch;
    const revision = other.manualMatchRevision ?? 0;
    const previous = assignments.get(match.file);
    if (!previous || revision > previous.revision || (revision === previous.revision && !match.covers.length)) assignments.set(match.file, { ...match, revision });
  }
  return [...assignments.values()].sort((a, b) => a.file.localeCompare(b.file));
};
const inputOf = (entry: QueueEntry) => JSON.stringify({
  attempt: entry.attempt, clientId: entry.clientId, hash: entry.transferHash,
  release: entry.release, manualMatch: entry.manualMatch, numbering: numberingOf(entry), replaceDestination: entry.replaceDestination === true,
  manualMatchRevision: entry.manualMatchRevision ?? 0,
  assignments: assignmentsOf(entry),
});
const libraryOf = (title: Title, step: JournalStep) => {
  const pointers = title.mediaType === 'movie' ? [title.fileId] : step.episodes.map((ref) => title.episodes.find((episode) => episode.season === ref.season && episode.number === ref.number)?.fileId);
  const files = Object.values(db.data.files).filter((file) => pointers.includes(file.id) || (file.titleKey === title.key && file.path === step.dest));
  return JSON.stringify({ root: db.data.roots[title.rootId], pointers, files: files.map((file) => ({ id: file.id, path: file.path, episodes: file.episodes, association: file.association })) });
};

export function bindJournal(journal: ImportJournal) {
  const title = db.data.titles[journal.titleKey];
  if (!title) return;
  for (const step of journal.steps) {
    if (step.state !== 'planned') continue;
    step.expected ??= {
      entries: Object.fromEntries(step.entryIds.map((id) => [id, db.data.queue[id] ? inputOf(db.data.queue[id]!) : ''])),
      library: libraryOf(title, step),
    };
  }
}

export function createImporter({ queue, events, clients, save, probe = probeFile, status, checkDelayMs = 100, fs = {}, afterStep, now = Date.now }: ImporterDeps) {
  const ops: Fs = { link: fs.link ?? fsLink, copyFile: fs.copyFile ?? fsCopyFile, rename: fs.rename ?? fsRename };
  const wait = async () => {
    if (checkDelayMs > 0) await sleep(checkDelayMs);
  };

  const entriesOf = (ids: string[]) => ids.map((id) => queue.get(id)).filter((entry): entry is QueueEntry => Boolean(entry));
  const current = (journal: ImportJournal, step: JournalStep) => {
    if (db.data.imports[journal.id] !== journal || !journal.steps.includes(step)) throw new StaleImport();
    const title = db.data.titles[journal.titleKey];
    if (!title) throw new StaleImport();
    if (journal.kind !== 'rename' && step.entryIds.some((id) => {
      const entry = queue.get(id);
      return !entry || (entry.state.kind !== 'importing' && !(entry.state.kind === 'available' && (step.state === 'committed' || step.state === 'retired')));
    })) throw new StaleImport();
    if (!step.expected) return;
    if (Object.entries(step.expected.entries).some(([id, input]) => {
      const entry = queue.get(id);
      return !entry || inputOf(entry) !== input;
    }) || libraryOf(title, step) !== step.expected.library) throw new StaleImport();
  };
  const block = (entries: QueueEntry[], code: string, detail?: string) => {
    for (const entry of entries) {
      if (entry.replaceDestination) {
        entry.replaceDestination = undefined;
        queue.touch(entry);
      }
      catalog.warn('import_blocked', `Import blocked: ${code}${detail ? ` (${detail})` : ''}`, itemFields(entry), { code, detail: detail ?? null });
      queue.endAttempt(entry, 'failed', code);
      queue.block(entry, { code, ...(detail ? { detail } : {}) }, 'import blocked', code);
    }
  };

  // --- Plan -------------------------------------------------------------------------------

  type Pick = { file: ImporterFound; entries: QueueEntry[]; episodes: Episode[]; source: 'manual' | 'numbering' | 'automatic'; probe?: ProbeResult; identity?: JournalStep['sourceIdentity'] };
  type Picks = { picks: Pick[]; missing: QueueEntry[]; unknown: QueueEntry[]; coverage: Episode[]; complete: boolean };

  async function pick(title: Title, group: QueueEntry[], files: ImporterFound[], content: string): Promise<Picks> {
    const picks: Pick[] = [];
    const taken = new Set<string>();
    const episodesOf = (refs: { season: number; number: number }[]) => refs.map((ref) => title.episodes.find((episode) => episode.season === ref.season && episode.number === ref.number)).filter((episode): episode is Episode => Boolean(episode));
    const sameCoverage = (a: { season: number; number: number }[], b: { season: number; number: number }[]) => a.length === b.length && a.every((one) => b.some((other) => one.season === other.season && one.number === other.number));
    // The name of the release, or the folder of the download, can give the season that the client leaves out of each
    // file name. A group of several seasons has no one season for these files.
    const seasons = new Set(group.map((entry) => entry.season));
    const releaseName = group.find((entry) => entry.release)?.release?.title ?? '';
    const seasonHint = seasons.size === 1 ? (parseRelease(releaseName).season ?? parseRelease(basename(content)).season ?? group[0]!.season) : null;

    if (title.mediaType === 'movie') {
      const entry = group[0]!;
      const chosen = entry.manualMatch ? files.find((file) => file.rel === entry.manualMatch!.file) : files.length === 1 ? files[0] : undefined;
      return chosen
        ? { picks: [{ file: chosen, entries: [entry], episodes: [], source: entry.manualMatch ? 'manual' : 'automatic' }], missing: [], unknown: [], coverage: [], complete: true }
        : { picks, missing: files.length ? [] : group, unknown: files.length ? group : [], coverage: [], complete: false };
    }

    const assignments = new Map(assignmentsOf(group[0]!).map((assignment) => [assignment.file, assignment]));
    for (const entry of group) {
      const match = entry.manualMatch;
      if (!match?.covers.length || (entry.manualMatchRevision ?? 0) < (assignments.get(match.file)?.revision ?? 0)) continue;
      assignments.set(match.file, { ...match, revision: entry.manualMatchRevision ?? 0 });
    }
    const unassigned = new Set([...assignments.values()].filter((match) => !match.covers.length && files.some((file) => file.rel === match.file)).map((match) => match.file));
    // A match that the user made comes first. It survives a retry.
    for (const manual of assignments.values()) {
      const file = files.find((item) => item.rel === manual.file);
      if (!file || taken.has(file.rel) || !manual.covers.length) continue;
      const episodes = episodesOf(manual.covers);
      if (!episodes.length || episodes.length !== manual.covers.length) continue;
      const covered = group.filter((other) => manual.covers.some((c) => c.season === other.season && c.number === other.number) && (!other.manualMatch || (other.manualMatch.file === manual.file && ((other.manualMatchRevision ?? 0) < manual.revision || !other.manualMatch.covers.length || sameCoverage(other.manualMatch.covers, manual.covers)))));
      if (!covered.length || [...assignments.values()].some((other) => other.file !== manual.file && other.covers.some((ref) => manual.covers.some((one) => ref.season === one.season && ref.number === one.number)))) continue;
      picks.push({ file, entries: covered, episodes, source: 'manual' });
      taken.add(file.rel);
    }
    for (const path of unassigned) taken.add(path);
    const done = () => new Set(picks.flatMap((p) => p.entries.map((e) => e.id)));
    // The numbering of the acquisition, saved with its release. A target of an older version has none, so the title map
    // applies. The release numbers go to the catalog episodes through it.
    const numbering = numberingOf(group[0]!);
    const sourceCoverage = inspectCoverage(files.map((file) => file.rel), title, numbering, seasonHint);
    const probes = new Map<string, ProbeResult>();
    const identities = new Map<string, NonNullable<JournalStep['sourceIdentity']>>();
    for (const file of files) {
      if (taken.has(file.rel)) continue;
      const before = await stat(file.abs);
      probes.set(file.rel, await probe(file.abs));
      const info = await stat(file.abs);
      if (!info.isFile() || before.size !== info.size || before.mtimeMs !== info.mtimeMs || before.dev !== info.dev || before.ino !== info.ino) throw new StaleImport();
      identities.set(file.rel, { sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino });
    }
    const evidence = files.filter((file) => probes.has(file.rel)).map((file) => evidenceOf(file.rel, probes.get(file.rel)!));
    const matched = matchContent(evidence.map((file) => ({ ...file, durationSeconds: null })), title.episodes);
    const unknown = new Set(unassigned);
    const uncertain = new Set<string>();
    const coverage = picks.flatMap((item) => item.episodes);
    const point = (episode: { season: number; number: number }) => `${episode.season}:${episode.number}`;
    for (const file of [...files].sort((a, b) => b.sizeBytes - a.sizeBytes)) {
      if (taken.has(file.rel)) continue;
      const positionOnly = seasonHint === null && !parseEpisodes(file.rel) && /(?:^|[ ._-])\d{1,3}\.[^.]+$/.test(file.rel);
      const ambiguousNumbering = sourceCoverage.ambiguous.includes(file.rel);
      const named = positionOnly || ambiguousNumbering ? [] : episodesOf(inspectCoverage([file.rel], title, numbering, seasonHint).episodes);
      const proposal = matched.proposals.find((item) => item.path === file.rel);
      const exact = proposal && (proposal.step === 'whole_title' || proposal.step === 'segments') ? episodesOf(proposal.episodes) : [];
      const tags = evidence.find((item) => item.path === file.rel)!;
      const tagged = tags.season !== null && tags.episode !== null;
      const tagEpisodes = tagged && !ambiguousNumbering ? episodesOf(inspectCoverage([`S${tags.season}E${tags.episode}.mkv`], title, numbering).episodes) : [];
      const conflict = matched.rejections.some((item) => item.path === file.rel && item.reason === 'conflict')
        || (tagged && !ambiguousNumbering && !tagEpisodes.length)
        || (!ambiguousNumbering && parseEpisodes(file.rel, seasonHint) && !named.length && (exact.length || tagEpisodes.length))
        || (exact.length && named.length && !sameCoverage(exact, named))
        || (tagEpisodes.length && named.length && !sameCoverage(tagEpisodes, named))
        || (tagEpisodes.length && exact.length && !sameCoverage(tagEpisodes, exact));
      const manualConflict = assignments.has(file.rel);
      // A partial title, similarity, or elimination is a proposal, not an identity.
      const weakTitle = tags.title?.includes('/') && !exact.length;
      if (conflict || manualConflict || weakTitle || (!exact.length && !named.length && !tagEpisodes.length)) {
        unknown.add(file.rel);
        for (const episode of [...named, ...exact, ...tagEpisodes]) uncertain.add(point(episode));
        continue;
      }
      const episodes = exact.length ? exact : named.length ? named : tagEpisodes;
      coverage.push(...episodes);
      if (picks.some((item) => item.episodes.some((one) => episodes.some((other) => one.season === other.season && one.number === other.number)))) {
        unknown.add(file.rel);
        continue;
      }
      const covered = group.filter((entry) => !entry.manualMatch && episodes.some((one) => one.season === entry.season && one.number === entry.number) && !done().has(entry.id));
      // A file for an episode that was not asked for is part of the pack. It is not imported.
      if (!covered.length) continue;
      const parsed = parseEpisodes(file.rel, seasonHint);
      const mapped = numbering?.ranges.length && (parsed || tagged);
      picks.push({ file, entries: covered, episodes, source: mapped && !exact.length ? 'numbering' : 'automatic', probe: probes.get(file.rel), identity: identities.get(file.rel) });
      taken.add(file.rel);
    }
    const left = group.filter((entry) => !done().has(entry.id));
    const pending = inspectCoverage([...unknown], title, numbering, seasonHint);
    const unresolved = left.filter((entry) => {
      if (entry.manualMatch) return files.some((file) => file.rel === entry.manualMatch!.file);
      if (unassigned.size) return true;
      if (!unknown.size) return false;
      const episode = { season: entry.season!, number: entry.number! };
      return uncertain.has(point(episode)) || pending.status(episode) !== 'absent';
    });
    return { picks, missing: left.filter((entry) => !unresolved.includes(entry)), unknown: unresolved, coverage, complete: files.length > 0 && unknown.size === 0 };
  }

  async function plan(hash: string, group: QueueEntry[], handle: ClientHandle): Promise<ImportJournal | undefined> {
    const inputs = new Map(group.map((entry) => [entry.id, inputOf(entry)]));
    const library = () => JSON.stringify({
      root: db.data.roots[db.data.titles[group[0]!.titleKey]?.rootId ?? ''],
      pointers: db.data.titles[group[0]!.titleKey]?.episodes.map((episode) => [episode.season, episode.number, episode.fileId]),
      files: Object.values(db.data.files).filter((file) => file.titleKey === group[0]!.titleKey),
    });
    const beforeLibrary = library();
    const currentPlan = () => {
      if (library() !== beforeLibrary || group.some((entry) => queue.get(entry.id) !== entry || entry.state.kind !== 'importing' || inputOf(entry) !== inputs.get(entry.id))) throw new StaleImport();
    };
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
        currentPlan();
        status?.setCheck(key, id, 'ok');
        return value;
      } catch (error) {
        currentPlan();
        if (error instanceof StaleImport) throw error;
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
        if (error instanceof StaleImport) throw error;
        failGroup(problemOf(error));
        return undefined;
      }
    };

    // The download is complete before the import checks. The poll moves a finished download to Importing.
    status?.setCheck(key, 'download_complete', 'running');
    await wait();
    // The import confirms the download now, so an older read of the client cannot answer.
    clients.invalidate(handle);
    const torrent = await handle.api.find(hash);
    currentPlan();
    if (!torrent) {
      status?.setCheck(key, 'download_complete', 'failed', { code: 'torrent_missing' });
      block(group, 'torrent_missing');
      return;
    }
    if (!torrent.complete) {
      // The client has not finished. The target waits in Importing, and the next poll starts a new run.
      status?.setCheck(key, 'download_complete', 'pending');
      return;
    }
    status?.setCheck(key, 'download_complete', 'ok');

    // Checks 2-15 belong to Importing. Every target of the group moves there before the first one.
    for (const entry of group) queue.enter(entry, 'importing', 'import started');
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

    let picked: Picks;
    try {
      picked = await run('files_found', async () => {
        const files = await torrentVideos(handle, clientTorrent);
        const result = await pick(title, group, files ?? [], content);
        currentPlan();
        const ref = group[0]!.release;
        const season = result.missing[0]?.season;
        if (ref && result.complete && season !== null && season !== undefined && result.missing.every((entry) => entry.season === season)) {
          const key = `${ref.indexerId}:${ref.guid}`;
          const revision = numberingOf(group[0]!)?.revision ?? 0;
          if (!db.data.releaseCoverage[key] || db.data.releaseCoverage[key]!.numberingRevision <= revision) db.data.releaseCoverage[key] = {
            titleKey: title.key, season, numbers: [...new Set(result.coverage.filter((episode) => episode.season === season).map((episode) => episode.number))].sort((a, b) => a - b), numberingRevision: revision,
          };
        }
        if (!result.picks.length) throw new ImportProblem(result.unknown.length ? 'file_unmapped' : 'file_not_found');
        return result;
      });
    } catch (error) {
      if (error instanceof StaleImport) throw error;
      failGroup(problemOf(error));
      return;
    }
    if (picked.unknown.length) block(picked.unknown, 'file_unmapped');
    // Only identified files can prove that the other episodes are absent.
    if (picked.missing.length) block(picked.missing, 'pack_partial');

    const activeInputs = new Map(group.filter((entry) => entry.state.kind === 'importing').map((entry) => [entry.id, inputs.get(entry.id)!]));
    const currentCandidates = () => {
      if (library() !== beforeLibrary || [...activeInputs].some(([id, input]) => {
        const entry = queue.get(id);
        return !entry || entry.state.kind !== 'importing' || inputOf(entry) !== input;
      })) throw new StaleImport();
    };
    type Candidate = Pick & { dest: string | null; replaces: string | null; validation: 'ffprobe' | 'basic'; failed: boolean; identity?: JournalStep['sourceIdentity'] };
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
          currentCandidates();
        } catch (error) {
          currentCandidates();
          if (error instanceof StaleImport) throw error;
          const problem = problemOf(error);
          candidate.failed = true;
          failure ??= problem;
          block(candidate.entries, problem.code, problem.message === problem.code ? undefined : problem.message);
          for (const entry of candidate.entries) activeInputs.delete(entry.id);
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
      const before = await stat(candidate.file.abs);
      const result = candidate.probe ?? await probe(candidate.file.abs);
      const info = await stat(candidate.file.abs);
      if (!info.isFile() || before.size !== info.size || before.mtimeMs !== info.mtimeMs || before.dev !== info.dev || before.ino !== info.ino) throw new ImportProblem('file_unreadable');
      if (candidate.identity && (candidate.identity.sizeBytes !== info.size || candidate.identity.mtimeMs !== info.mtimeMs || candidate.identity.dev !== info.dev || candidate.identity.ino !== info.ino)) throw new StaleImport();
      if (result.ok === false) throw new ImportProblem('file_unreadable', result.reason);
      // Without ffprobe the check is basic: the file has data. A health problem tells the user.
      if (result.ok === 'skipped' && candidate.file.sizeBytes === 0) throw new ImportProblem('file_unreadable', 'empty');
      candidate.validation = result.ok === true ? 'ffprobe' : 'basic';
      candidate.identity = { sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino };
    });
    if (!readable) return;

    // The label of a version that the destination name does not give: its resolution, or else its source.
    const versionLabel = (candidate: Candidate) => {
      const release = candidate.entries.find((entry) => entry.release)?.release;
      const parsed = release ? parseRelease(release.title) : parseRelease(basename(candidate.file.abs));
      if (parsed.resolution !== null) return `${parsed.resolution}p`;
      return parsed.source === 'unknown' ? 'version' : parsed.source;
    };

    const nameFree = async (candidate: Candidate, path: string) => {
      if (candidates.some((other) => other !== candidate && other.dest === path)) return false;
      if (Object.values(db.data.files).some((file) => file.titleKey === title.key && file.path === path)) return false;
      return !(await lstat(join(rootReal!, path)).catch(() => undefined));
    };

    // A new version goes next to the file that holds the name. A taken name gets a number.
    const versionDestination = async (candidate: Candidate, dest: string) => {
      const label = versionLabel(candidate);
      for (let n = 1; ; n++) {
        const path = versionedPath(dest, n === 1 ? label : `${label} (${n})`);
        if (await nameFree(candidate, path)) return path;
      }
    };

    const free = await perFile('destination_free', async (candidate) => {
      const dest = candidate.dest!;
      const entry = candidate.entries.find((item) => item.clientId && item.transferHash);
      const recordedAt = (path: string) => Object.values(db.data.files).find((file) => file.titleKey === title.key && file.path === path);
      const fromSameTorrent = (file: MediaFile | undefined) => Boolean(file?.download && entry && file.download.clientId === entry.clientId && file.download.hash === entry.transferHash);
      const currentIds = title.mediaType === 'movie' ? [title.fileId] : candidate.episodes.map((episode) => episode.fileId);
      const sameSource = Object.values(db.data.files).find((file) => file.titleKey === title.key && fromSameTorrent(file) && file.association?.originalName === candidate.file.rel);
      if (sameSource && candidate.source !== 'manual' && (sameSource.episodes.length !== candidate.episodes.length || sameSource.episodes.some((ref) => !candidate.episodes.some((episode) => ref.season === episode.season && ref.number === episode.number)))) throw new ImportProblem('file_unmapped');
      const same = sameSource ?? currentIds.map((id) => (id ? db.data.files[id] : undefined)).find((file) => fromSameTorrent(file));
      const replace = candidate.entries.some((item) => item.replaceDestination);
      // A torrent that gave a file of this title already updates that file, so it does not add a second record.
      if (same && same.path !== dest) {
        const target = await lstat(join(rootReal!, same.path)).catch(() => undefined);
        if (target?.isDirectory()) throw new ImportProblem('destination_exists', same.path);
        candidate.dest = same.path;
        candidate.replaces = same.path;
        return;
      }
      const recorded = recordedAt(dest);
      const target = await lstat(join(rootReal!, dest)).catch(() => undefined);
      if ((same && same.path === dest) || (recorded && fromSameTorrent(recorded))) {
        if (target?.isDirectory()) throw new ImportProblem('destination_exists', dest);
        candidate.replaces = dest;
        return;
      }
      // A recorded file at the destination stays. The new file takes a version name next to it.
      if (recorded) {
        if (target?.isDirectory()) throw new ImportProblem('destination_exists', dest);
        if (replace) {
          candidate.replaces = dest;
          return;
        }
        if (!target) return;
        candidate.dest = await versionDestination(candidate, dest);
        candidate.replaces = null;
        return;
      }
      // A file that the library does not know still blocks the destination, unless the user asked to replace it.
      if (target) {
        // The destination is this download already: an earlier run published it and stopped before the record. It is
        // the same file, so the import finishes instead of asking the user about a file that is its own.
        const source = await stat(candidate.file.abs);
        currentCandidates();
        if (target.isFile() && target.ino === source.ino && target.dev === source.dev) {
          candidate.replaces = null;
          return;
        }
        if (!replace || target.isDirectory()) throw new ImportProblem('destination_exists', dest);
        currentCandidates();
        await unlink(join(rootReal!, dest));
      }
      candidate.replaces = null;
    });
    if (!free) return;

    status?.setCheck(key, 'names_unique', 'running');
    await wait();
    currentCandidates();
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
      sizeBytes: candidate.identity?.sizeBytes ?? candidate.file.sizeBytes,
      episodes: candidate.episodes.map((e) => ({ season: e.season, number: e.number })),
      validation: candidate.validation,
      association: { source: candidate.source, originalName: candidate.file.rel, numberingRevision: numberingOf(candidate.entries[0]!)?.revision ?? 0 },
      sourceIdentity: candidate.identity,
    }));
    if (!steps.length) return;

    const journal: ImportJournal = { id: randomUUID(), hash, titleKey: title.key, steps, createdAt: now(), clientId: handle.id, downloadBase: base };
    for (const step of steps) step.expected = { entries: Object.fromEntries(step.entryIds.map((id) => [id, inputs.get(id)!])), library: libraryOf(title, step) };
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
    currentCandidates();
    return journal;
  }

  // --- Execute ----------------------------------------------------------------------------

  async function stage(journal: ImportJournal, step: JournalStep, rootReal: string, base: string) {
    current(journal, step);
    const dest = join(rootReal, step.dest);
    const stagePath = join(dirname(dest), `.ladarr-${journal.id.slice(0, 8)}-${basename(dest)}`);
    await mkdir(dirname(dest), { recursive: true });
    // The folders were just made. They must be inside the root, also after links are resolved.
    if (!inside(rootReal, await realpath(dirname(dest)))) throw new ImportProblem('destination_outside_root');
    const source = join(base, step.source);
    const info = await stat(source);
    current(journal, step);
    const identity = step.sourceIdentity;
    if (!info.isFile() || (identity && !sameIdentity(identity, info))) throw new ImportProblem('file_unreadable');
    await rm(stagePath, { force: true });
    current(journal, step);
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
      current(journal, step);
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
    const [staged, sourceInfo] = await Promise.all([stat(stagePath), stat(source)]);
    current(journal, step);
    if (!staged.isFile() || staged.size !== step.sizeBytes || (identity && !sameIdentity(identity, sourceInfo))) throw new ImportProblem('file_unreadable');
    step.stagedIdentity = { sizeBytes: staged.size, mtimeMs: staged.mtimeMs, dev: staged.dev, ino: staged.ino };
    return stagePath;
  }

  const stagePathOf = (journal: ImportJournal, step: JournalStep, rootReal: string) => join(dirname(join(rootReal, step.dest)), `.ladarr-${journal.id.slice(0, 8)}-${basename(step.dest)}`);

  async function cleanupStage(journal: ImportJournal, step: JournalStep, rootReal: string) {
    const stagePath = stagePathOf(journal, step, rootReal);
    const [staged, published] = await Promise.all([lstat(stagePath).catch(() => undefined), lstat(join(rootReal, step.dest)).catch(() => undefined)]);
    current(journal, step);
    if (staged?.isFile() && published?.isFile() && staged.ino === published.ino && staged.dev === published.dev) {
      await unlink(stagePath).catch((error) => {
        if (errno(error) !== 'ENOENT') throw error;
      });
    }
  }

  async function publish(journal: ImportJournal, step: JournalStep, rootReal: string) {
    current(journal, step);
    const dest = join(rootReal, step.dest);
    const stagePath = stagePathOf(journal, step, rootReal);
    if (step.replaces === step.dest) {
      // The same name: replace the old data in one step.
      await ops.rename(stagePath, dest);
      await cleanupStage(journal, step, rootReal);
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
    await cleanupStage(journal, step, rootReal);
  }

  // A rename keeps the library record of the file. Only its path changes.
  async function commitRename(journal: ImportJournal, step: JournalStep, rootReal: string) {
    const info = await stat(join(rootReal, step.dest));
    current(journal, step);
    if (!info.isFile() || (step.stagedIdentity && !sameIdentity(step.stagedIdentity, info))) throw new ImportProblem('file_unreadable');
    // No await from here, so the record changes in one step. A restart can find the record at the new path already.
    const file = Object.values(db.data.files).find((item) => item.titleKey === journal.titleKey && (item.path === step.replaces || item.path === step.dest));
    if (file) Object.assign(file, { path: step.dest, sizeBytes: info.size, mtimeMs: info.mtimeMs, missing: false });
    step.state = 'committed';
    const title = db.data.titles[journal.titleKey];
    if (title && step.expected) step.expected.library = libraryOf(title, step);
  }

  // A manual folder import can finish a waiting search, but it cannot resume a blocked target or an active download.
  function settleQueue(title: Title, step: JournalStep) {
    const ids = title.mediaType === 'movie' ? [title.key] : step.episodes.map((c) => entryId(title.key, c.season, c.number));
    for (const entry of ids.map((id) => queue.get(id))) {
      if (!entry || entry.attempt === 0 || !isActive(entry) || entry.state.kind === 'paused' || entry.state.kind === 'blocked') continue;
      const phase = phaseOfEntry(entry);
      if (phase !== 'queued' && phase !== 'searching') continue;
      queue.endAttempt(entry, 'imported', 'imported by hand');
      entry.importResult = { at: now(), ok: true, method: step.method, path: step.dest, validation: step.validation };
      catalog.info('import_completed', `Import completed by hand: ${step.dest}`, itemFields(entry), { path: step.dest, method: step.method, validation: step.validation, manual: true });
      queue.complete(entry, 'imported by hand', step.method ?? undefined);
    }
  }

  async function commit(journal: ImportJournal, step: JournalStep, rootReal: string) {
    if (journal.kind === 'rename') return commitRename(journal, step, rootReal);
    const info = await stat(join(rootReal, step.dest));
    current(journal, step);
    if (!info.isFile() || info.size !== step.sizeBytes || info.size === 0 || (step.stagedIdentity && !sameIdentity(step.stagedIdentity, info))) throw new ImportProblem('file_unreadable');
    if (!step.stagedIdentity) {
      const result = await probe(join(rootReal, step.dest));
      const after = await stat(join(rootReal, step.dest));
      current(journal, step);
      if (result.ok === false || !sameIdentity({ sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino }, after)) throw new ImportProblem('file_unreadable');
    }
    // No await from here, so the library record and the queue change in one step.
    const title = db.data.titles[journal.titleKey];
    if (!title) return;
    const existing = Object.values(db.data.files).find((file) => file.titleKey === title.key && file.path === step.dest);
    const file: MediaFile = existing ?? { id: randomUUID(), titleKey: title.key, path: step.dest, sizeBytes: info.size, mtimeMs: info.mtimeMs, episodes: step.episodes, missing: false, addedAt: now() };
    // The source and the resolution of the release go with the file, so a later upgrade knows what the file is.
    const release = entriesOf(step.entryIds).find((entry) => entry.release)?.release;
    const parsed = release ? parseRelease(release.title) : null;
    // The torrent that gave the file goes with it, so a removal can delete it later. A manual import has none.
    const source = entriesOf(step.entryIds).find((entry) => entry.clientId && entry.transferHash);
    const download = source ? { clientId: source.clientId!, hash: source.transferHash!, external: source.release?.external === true } : null;
    const inPlace = journal.sourceBase && step.source === step.dest && existing?.association && sameIdentity(existing.association.identity, info);
    Object.assign(file, { sizeBytes: info.size, mtimeMs: info.mtimeMs, episodes: step.episodes, missing: false, source: inPlace ? existing!.source ?? null : parsed?.source ?? null, resolution: inPlace ? existing!.resolution ?? null : parsed?.resolution ?? null, download: inPlace ? existing!.download ?? null : download });
    file.association = step.association ? { ...step.association, identity: { sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino } } : undefined;
    db.data.files[file.id] = file;

    const covered = title.mediaType === 'movie' ? [] : step.episodes.map((c) => title.episodes.find((e) => e.season === c.season && e.number === c.number)).filter((e): e is Episode => Boolean(e));
    // A new version keeps the record of the file that it does not replace. An explicit replace removes it with its file.
    const previous = new Set<string>();
    if (title.mediaType === 'movie') {
      if (title.fileId && title.fileId !== file.id) previous.add(title.fileId);
      title.fileId = file.id;
    } else {
      for (const episode of title.episodes) {
        if (episode.fileId === file.id && !covered.includes(episode)) {
          episode.fileId = null;
          const entry = queue.get(entryId(title.key, episode.season, episode.number));
          if (entry?.state.kind === 'available') queue.invalidate(entry, 'mapping removed the file association');
        }
      }
      for (const episode of covered) {
        if (episode.fileId && episode.fileId !== file.id) previous.add(episode.fileId);
        episode.fileId = file.id;
      }
    }
    if (step.replaces && step.replaces !== step.dest) {
      for (const id of previous) {
        const stillUsed = title.fileId === id || title.episodes.some((e) => e.fileId === id);
        if (!stillUsed) delete db.data.files[id];
      }
    }
    title.folder ??= step.dest.split('/')[0]!;
    if (journal.sourceBase) settleQueue(title, step);
    for (const entry of entriesOf(step.entryIds)) {
      if (entry.state.kind !== 'importing') continue;
      entry.importResult = { at: now(), ok: true, method: step.method, path: step.dest, validation: step.validation };
      if (entry.replaceDestination) {
        entry.replaceDestination = undefined;
        queue.touch(entry);
        if (step.expected) step.expected.entries[entry.id] = inputOf(entry);
      }
      // A download import moves its targets to Available after every step is retired. A manual import and a rename
      // finish each target here.
      if (!journal.sourceBase) continue;
      catalog.info('import_completed', `Import completed: ${step.dest}`, itemFields(entry), { path: step.dest, method: step.method, validation: step.validation });
      queue.endAttempt(entry, 'imported');
      queue.complete(entry, 'imported', step.method ?? undefined);
    }
    step.state = 'committed';
    if (step.expected) step.expected.library = libraryOf(title, step);
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
    current(journal, step);
    await cleanupStage(journal, step, rootReal);
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
  async function checkSource(journal: ImportJournal, step: JournalStep, base: string) {
    if (db.data.titles[journal.titleKey]?.mediaType === 'movie' && step.association?.source !== 'manual') {
      const videos = await listVideos(base, { skipHidden: true });
      current(journal, step);
      if (videos.length > 1) throw new ImportProblem('file_unmapped');
    }
    const info = await stat(join(base, step.source));
    current(journal, step);
    if (step.sourceIdentity && !sameIdentity(step.sourceIdentity, info)) throw new ImportProblem('file_unreadable');
    const result = await probe(join(base, step.source));
    const after = await stat(join(base, step.source));
    current(journal, step);
    if (!info.isFile() || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.dev !== after.dev || info.ino !== after.ino) throw new ImportProblem('file_unreadable');
    if (result.ok === false) throw new ImportProblem('file_unreadable', result.reason);
    if (result.ok === 'skipped' && step.sizeBytes === 0) throw new ImportProblem('file_unreadable', 'empty');
    step.validation = result.ok === true ? 'ffprobe' : 'basic';
    step.sourceIdentity ??= { sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino };
  }

  // A download import moves its targets to Available only when every step is retired. Until then they stay in
  // Importing, and every target of the group shows the same check list.
  function finishDownload(journal: ImportJournal) {
    const done = new Set<string>();
    for (const step of journal.steps) {
      for (const entry of entriesOf(step.entryIds)) {
        current(journal, step);
        if (entry.state.kind !== 'importing') continue;
        if (done.has(entry.id)) continue;
        done.add(entry.id);
        entry.importResult = { at: now(), ok: true, method: step.method, path: step.dest, validation: step.validation };
        catalog.info('import_completed', `Import completed: ${step.dest}`, itemFields(entry), { path: step.dest, method: step.method, validation: step.validation });
        queue.endAttempt(entry, 'imported');
        queue.complete(entry, 'imported', step.method ?? undefined);
      }
    }
  }

  // Moves each step forward from the state that it has. A restart calls this again, so every state can start from itself.
  async function advance(journal: ImportJournal) {
    if (!journal.sourceBase && journal.steps.some((step) => entriesOf(step.entryIds).some((entry) => entry.state.kind !== 'importing' && entry.state.kind !== 'available'))) return;
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
    if (journal.sourceBase) bindJournal(journal);
    if (journal.sourceBase) for (const step of journal.steps) {
      if (step.state !== 'planned') continue;
      if (journal.kind !== 'rename') step.association ??= {
        source: entriesOf(step.entryIds).some((entry) => entry.manualMatch) ? 'manual' : 'automatic',
        originalName: step.source,
        numberingRevision: 0,
      };
    }
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
      current(journal, step);
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

    // A step that fails before its file has its final name goes out, and its targets are blocked. The other steps of
    // the import go on. A failure after the name is there can not be undone, so the journal keeps the step and the next
    // run finishes it. The file is not left in the library without a record.
    const failed = async (step: JournalStep, error: unknown): Promise<ImportProblem> => {
      current(journal, step);
      const problem = problemOf(error);
      if (step.state !== 'planned' && step.state !== 'staged') throw error;
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
            if (journal.kind !== 'rename') await checkSource(journal, step, base);
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
          if (error instanceof StaleImport) throw error;
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
            current(journal, step);
            await advance(step);
          } catch (error) {
            if (error === crash) throw error;
            if (error instanceof StaleImport) throw error;
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
      if (!journal.sourceBase) {
        for (const step of journal.steps) {
          const info = await stat(join(rootReal, step.dest)).catch(() => undefined);
          current(journal, step);
          if (!info?.isFile() || info.size === 0 || info.size !== step.sizeBytes || (step.stagedIdentity && !sameIdentity(step.stagedIdentity, info))) {
            const file = Object.values(db.data.files).find((file) => file.titleKey === title.key && file.path === step.dest);
            if (file) file.missing = true;
            block(entriesOf(step.entryIds).filter((entry) => entry.state.kind === 'importing'), 'file_unreadable');
            await save();
            return;
          }
        }
        finishDownload(journal);
      }
      delete db.data.imports[journal.id];
      // The files are in, so a search only targets the episodes that have no file. A download import runs it too:
      // a pack can leave episodes without a file, and they must not wait for another action.
      if (journal.searchOnFinish || !journal.sourceBase) enqueueJob({ type: 'queue.initial', payload: { key: journal.titleKey }, dedupeKey: `initial:${journal.titleKey}` });
      await save();
      status?.finish(journal.id);
    }
    events.publish('library.changed', { key: journal.titleKey });
  }

  async function execute(journal: ImportJournal) {
    try {
      if (journal.correction) {
        await recoverCorrection(journal, { queue });
        if (db.data.imports[journal.id] !== journal) return;
      }
      await advance(journal);
    } catch (error) {
      if (!(error instanceof StaleImport)) throw error;
      const title = db.data.titles[journal.titleKey];
      const root = title && db.data.roots[title.rootId];
      if (root) {
        const rootReal = await realpath(root.path).catch(() => undefined);
        if (rootReal) for (const step of journal.steps) {
          if (step.state === 'planned' || step.state === 'staged') await rm(stagePathOf(journal, step, rootReal), { force: true }).catch(() => {});
          if (step.state === 'published' && step.stagedIdentity) {
            const info = await stat(join(rootReal, step.dest)).catch(() => undefined);
            const recorded = Object.values(db.data.files).some((file) => file.titleKey === journal.titleKey && file.path === step.dest);
            if (!recorded && info?.isFile() && sameIdentity(step.stagedIdentity, info)) await unlink(join(rootReal, step.dest)).catch(() => {});
          }
        }
      }
      if (db.data.imports[journal.id] === journal) delete db.data.imports[journal.id];
      await save();
      status?.finish(journal.id);
    }
  }

  async function run(hash: string) {
    // A journal from an earlier run comes first, so an interrupted import ends before a new one starts.
    for (const journal of Object.values(db.data.imports).filter((item) => item.hash === hash)) await execute(journal);

    const inJournal = new Set(Object.values(db.data.imports).flatMap((journal) => journal.steps.flatMap((step) => step.entryIds)));
    const ready = Object.values(db.data.queue).filter((entry) => entry.transferHash === hash && entry.state.kind === 'importing' && !inJournal.has(entry.id));
    // The targets of one torrent have the same client.
    const handle = clients.get(ready[0]?.clientId);
    if (!handle) return;
    const groups = new Map<string, QueueEntry[]>();
    for (const entry of ready) {
      const key = JSON.stringify([entry.titleKey, numberingOf(entry)]);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const group of groups.values()) {
      let journal: ImportJournal | undefined;
      try {
        journal = await plan(hash, group, handle);
      } catch (error) {
        if (error instanceof StaleImport) continue;
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
// Importing with a torrent is unfinished too, also when no journal was written. A target that used its automatic
// attempts stays stuck until the user retries.
export const unfinishedImports = () => {
  const hashes = new Set(Object.values(db.data.imports).filter((journal) => journal.sourceBase || journal.steps.every((step) => step.entryIds.every((id) => {
    const entry = db.data.queue[id];
    return entry && (entry.state.kind === 'importing' || entry.state.kind === 'available');
  }))).map((journal) => journal.hash));
  for (const entry of Object.values(db.data.queue)) {
    if (!entry.transferHash || entry.state.kind !== 'importing') continue;
    if ((entry.importTries ?? 0) >= MAX_IMPORT_ATTEMPTS) continue;
    if (phaseOfEntry(entry) === 'importing') hashes.add(entry.transferHash);
  }
  return [...hashes];
};

// The video files of a download, for the "Match file" choice. Returns nothing when the download is not reachable.
export async function listDownloadFiles(handle: ClientHandle, hash: string): Promise<{ rel: string; sizeBytes: number }[] | undefined> {
  const torrent = await handle.api.find(hash);
  if (!torrent) return;
  return (await torrentVideos(handle, torrent))?.map(({ rel, sizeBytes }) => ({ rel, sizeBytes }));
}
