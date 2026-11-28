import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EpisodeRef } from '@ladarr/shared/types';
import { db } from '../../core/db.ts';
import { catalog, itemFields } from '../../core/log.ts';
import { inspectCoverage } from '../coverage.ts';
import { attachTorrent, recordTorrent } from '../downloads/attach.ts';
import { matchPath } from '../downloads/file-evidence.ts';
import { ClientError } from '../downloads/qbittorrent.ts';
import { addedByApp, isActive, matchesSentTorrent, phaseOfEntry } from '../downloads/queue.ts';
import { parseRelease, normalizeTitle } from '../grab/release.ts';
import { matchMovie, readCoverage, validMatches } from '../grab/match.ts';
import { normalizeNumbering, releasePoint } from '@ladarr/shared/numbering';
import { isSample, isVideoFile, releaseEpisodes } from '../parse.ts';
import { inside } from '../roots.ts';
import { linkedSources, readTitleFolder } from '../scan.ts';
import { torrentVideos } from './importer.ts';
import type { ClientHandle, Clients, InventoryFile, LocalResult, MediaFile, Queue, QueueEntry, Selection, Title, Torrent } from '../../types.ts';

// A target that a local import can resolve: it is on its way to a file, and no download owns it.
const eligible = (entry: QueueEntry) =>
  isActive(entry) && entry.state.kind !== 'paused' && entry.state.kind !== 'blocked' && !entry.transferHash && ['searching', 'importing'].includes(phaseOfEntry(entry));

const present = (fileId: string | null) => Boolean(fileId && db.data.files[fileId] && !db.data.files[fileId]!.missing);

const episodeOf = (title: Title, entry: QueueEntry) => (entry.season === null ? undefined : title.episodes.find((episode) => episode.season === entry.season && episode.number === entry.number));

const fileOf = (title: Title, entry: QueueEntry) => (title.mediaType === 'movie' ? title.fileId : (episodeOf(title, entry)?.fileId ?? null));

const numberingOf = (title: Title, entry: QueueEntry) => normalizeNumbering(entry.numbering === undefined ? title.numbering : entry.numbering);
const covers = (episodes: EpisodeRef[], entry: QueueEntry) => episodes.some((episode) => episode.season === entry.season && episode.number === entry.number);

// The names that a release of this title can use.
const namesOf = (title: Title) => [title.meta.title, title.meta.originalTitle, ...title.meta.aliases].map((name) => normalizeTitle(name)).filter((name) => name.length >= 3);

// The title and year identify a possible source. Its manifest establishes episode coverage.
function matches(title: Title, torrent: Torrent) {
  const parsed = parseRelease(torrent.name);
  if (!namesOf(title).includes(normalizeTitle(parsed.title))) return false;
  return title.mediaType !== 'movie' || parsed.year === null || title.meta.year === null || parsed.year === title.meta.year;
}

function downloadCoverage(files: string[], title: Title, entry: QueueEntry, torrent: Torrent, season: number | null) {
  const match = entry.retryDownload?.match;
  const selected = match && matchPath(files, (file) => file, torrent)(match.file);
  if (match && !selected) {
    if (entry.retryDownload?.upload || entry.release?.uploadPath) return 'absent';
    entry.retryDownload!.match = null;
  }
  if (title.mediaType === 'movie') {
    const movie = matchMovie(files, selected);
    if (movie.file) return 'identified';
    return movie.problem === 'no_video' && entry.retryDownload && torrent.complete ? 'absent' : 'unknown';
  }
  const assignments = selected ? { [selected]: match.covers } : undefined;
  if (assignments && !validMatches(files, title, assignments)) return 'unknown';
  const manifest = readCoverage(files, title, numberingOf(title, entry), assignments, season);
  if (entry.retryDownload && torrent.complete && !files.some((file) => isVideoFile(file) && !isSample(file))) return 'absent';
  return manifest.status({ season: entry.season!, number: entry.number! });
}

// A torrent that the client has already and that no target owns. The download stays with the target, also when a
// restart or a lost association left it alone. The client is read once for every target of the title.
async function attachDownloads({ queue, clients }: { queue: Queue; clients: Clients }, title: Title, entries: QueueEntry[]): Promise<{ attached: string[]; blocked: string[] }> {
  const open = entries.filter(eligible);
  if (!open.length) return { attached: [], blocked: [] };
  for (const entry of open) if (entry.retryDownload) delete entry.retryDownload.absent;
  const input = (entry: QueueEntry) => JSON.stringify({ state: entry.state, attempt: entry.attempt, release: entry.release, manualMatch: entry.manualMatch, numbering: numberingOf(title, entry) });
  const inputs = new Map(open.map((entry) => [entry.id, input(entry)]));
  const current = (entry: QueueEntry) => db.data.titles[title.key] === title && db.data.queue[entry.id] === entry && eligible(entry) && inputs.get(entry.id) === input(entry);
  // Another title keeps its torrent. Targets of this title can share identified coverage without releasing blocked targets.
  const claimed = new Set(Object.values(db.data.queue).flatMap((entry) => (entry.titleKey !== title.key && entry.transferHash ? [entry.transferHash] : [])));
  const found = new Map<string, { handle: ClientHandle; torrent: Torrent; targets: QueueEntry[] }>();
  const unknown = new Map<string, { handle: ClientHandle; torrent: Torrent; target: QueueEntry }>();
  for (const handle of clients.all()) {
    const candidates = open.filter((entry) => {
      const prior = entry.retryDownload;
      if (prior === undefined) return true;
      return prior && (!prior.clientId || prior.clientId === handle.id);
    });
    if (!candidates.length) continue;
    let list: Torrent[];
    try {
      list = await clients.list(handle, { fresh: true });
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      // A client that does not answer is not a client without the download. The search waits instead of a second copy.
      const targets = candidates.filter(current);
      for (const entry of targets) queue.block(entry, { code: 'client_unreachable' }, 'the download client did not answer');
      return { attached: [], blocked: targets.map((entry) => entry.id) };
    }
    for (const torrent of list) {
      const targetsOfTorrent = candidates.filter((entry) => {
        if (entry.retryDownload !== undefined) return entry.retryDownload?.hash === torrent.hash;
        return !claimed.has(torrent.hash) && matches(title, torrent);
      });
      if (!targetsOfTorrent.length) continue;
      let files: string[];
      let downloaded: string[] | undefined;
      try {
        if (torrent.complete && targetsOfTorrent.some((entry) => entry.retryDownload)) {
          downloaded = (await torrentVideos(handle, torrent))?.map((file) => file.clientPath) ?? [];
        }
        files = downloaded && targetsOfTorrent.every((entry) => entry.retryDownload) ? downloaded
          : (await handle.api.files(torrent.hash)).filter((file) => file.sizeBytes > 0).map((file) => file.name);
      } catch (error) {
        if (!(error instanceof ClientError)) throw error;
        const targets = targetsOfTorrent.filter(current);
        for (const target of targets) queue.block(target, { code: 'client_unreachable' }, 'the download client did not answer');
        return { attached: [], blocked: targets.map((target) => target.id) };
      }
      const parsed = parseRelease(torrent.name);
      const targets: QueueEntry[] = [];
      for (const target of targetsOfTorrent.filter(current)) {
        const prior = target.retryDownload;
        const paths = prior && downloaded ? downloaded : files;
        const numbering = numberingOf(title, target);
        const point = target.season === null ? null : releasePoint(numbering, { season: target.season, number: target.number! });
        const named = releaseEpisodes(torrent.name, title.episodes, numbering, null, title.meta.title);
        const targeted = title.mediaType === 'movie' || parsed.multiSeason || parsed.season === point?.season
          || Boolean(named && named.season === target.season && named.numbers.includes(target.number!));
        const status = downloadCoverage(paths, title, target, torrent, parsed.season);
        if (status === 'identified') targets.push(target);
        else if (status === 'absent' && prior) prior.absent = true;
        else if (status === 'unknown' && (prior || targeted)) {
          unknown.set(target.id, { handle, torrent, target });
        }
      }
      if (!targets.length) continue;
      const item = found.get(torrent.hash) ?? { handle, torrent, targets: [] };
      for (const target of targets) if (!item.targets.includes(target)) item.targets.push(target);
      found.set(torrent.hash, item);
    }
  }
  // One torrent for each target: a complete torrent first, then the one that is further along.
  const chosen = new Map<string, { handle: ClientHandle; torrent: Torrent; targets: QueueEntry[] }>();
  const ordered = [...found.values()].sort((a, b) => Number(b.torrent.complete) - Number(a.torrent.complete) || b.torrent.progress - a.torrent.progress);
  for (const item of ordered) {
    const targets = item.targets.filter((target) => current(target) && ![...chosen.values()].some((other) => other.targets.includes(target)));
    if (targets.length) chosen.set(item.torrent.hash, { ...item, targets });
  }
  for (const item of chosen.values()) {
    const { handle, torrent, targets } = item;
    await attachTorrent({ queue }, { handle, torrent, targets, cause: 'download found in the client', external: !matchesSentTorrent(torrent.hash, torrent.addedAt) });
  }
  const attached = [...chosen.values()].flatMap((item) => item.targets.filter((target) => target.state.kind !== 'blocked' && target.transferHash === item.torrent.hash).map((target) => target.id));
  const blocked: string[] = [];
  for (const { handle, torrent, target } of unknown.values()) {
    if (attached.includes(target.id) || !current(target)) continue;
    recordTorrent(target, { handle, torrent, kind: 'pack', external: true });
    if (target.numbering === undefined) target.numbering = structuredClone(numberingOf(title, target));
    queue.enter(target, 'importing', 'the source has an unassigned file');
    queue.endAttempt(target, 'failed', 'file_unmapped');
    queue.block(target, { code: 'file_unmapped' }, 'import blocked', 'file_unmapped');
    blocked.push(target.id);
  }
  return { attached, blocked };
}

// Reads the folder of a title before its targets search, and takes the files that are there as their files. A target
// whose file is in the folder never downloads again. Then a download that the client has already becomes the download
// of its target, so a lost association does not cause a second copy. A file that names no episode leaves the targets
// that it could cover for the user, because a download would only find the same files.
export async function importLocal({ queue, clients }: { queue: Queue; clients: Clients }, { titleKey, entryIds, localOnly = false }: { titleKey: string; entryIds?: string[]; localOnly?: boolean }): Promise<LocalResult> {
  const title = db.data.titles[titleKey];
  if (!title) return { imported: [], blocked: [] };
  const only = entryIds ? new Set(entryIds) : null;
  const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === titleKey && eligible(entry) && (!only || only.has(entry.id)));
  if (!entries.length) return { imported: [], blocked: [] };
  const input = (entry: QueueEntry) => JSON.stringify({ attempt: entry.attempt, numbering: numberingOf(title, entry), manualMatch: entry.manualMatch });
  const inputs = new Map(entries.map((entry) => [entry.id, input(entry)]));
  const current = (entry: QueueEntry) => db.data.titles[titleKey] === title && eligible(entry) && db.data.queue[entry.id] === entry && inputs.get(entry.id) === input(entry);

  const imported: string[] = [];
  const blocked: string[] = [];
  const done = new Set<string>();

  // The folder is read under the lock of the title, so a scan and a search do not interleave.
  const folder = await readTitleFolder(title, { guessedFolder: true });
  // The root says nothing about the files of the series. A download would put a second copy next to a file that the
  // app cannot see, so the targets wait instead.
  if (folder.status === 'root_unavailable') {
    const left = entries.filter(current);
    for (const entry of left) queue.block(entry, { code: 'root_unavailable' }, 'the root is not available');
    return { imported, blocked: left.map((entry) => entry.id) };
  }

  const stop = (entry: QueueEntry, code: string) => {
    if (!current(entry)) return;
    if (phaseOfEntry(entry) !== 'importing') queue.enter(entry, 'importing', 'import blocked');
    queue.endAttempt(entry, 'failed', code);
    queue.block(entry, { code }, 'import blocked', code);
    done.add(entry.id);
    blocked.push(entry.id);
  };
  const identities = new Map<string, NonNullable<MediaFile['association']>['identity']>();
  if (folder.status === 'ok') {
    for (const found of folder.files) {
      const info = await stat(join(folder.rootReal!, found.path)).catch(() => undefined);
      if (info?.isFile() && info.size > 0) identities.set(found.path, { sizeBytes: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino });
    }
  }
  const approved = (file: MediaFile) => {
    const expected = file.association?.identity;
    const actual = identities.get(file.path);
    return Boolean(expected && actual && expected.sizeBytes === actual.sizeBytes && expected.mtimeMs === actual.mtimeMs
      && (expected.dev === undefined || expected.dev === actual.dev) && (expected.ino === undefined || expected.ino === actual.ino));
  };
  const sources = await linkedSources(clients, localOnly ? [] : folder.files.filter((file) => {
    const actual = identities.get(file.path);
    return actual?.dev === file.dev && actual?.ino === file.ino && actual?.mtimeMs === file.mtimeMs && actual?.sizeBytes === file.sizeBytes;
  }));
  // A saved pointer is not proof of content. Only unchanged files with approved coverage can complete the import.
  for (const entry of entries) {
    if (!current(entry) || entry.manualMatch) continue;
    const fileId = fileOf(title, entry);
    if (!present(fileId)) continue;
    const file = db.data.files[fileId!]!;
    if (entry.retryDownload !== undefined && file.titleKey === title.key && (folder.status === 'ok' || folder.status === 'folder_missing')
      && !folder.files.some(({ path }) => path === file.path)) continue;
    if (file.titleKey !== title.key || !approved(file) || (title.mediaType === 'tv' && !covers(file.episodes, entry))) {
      stop(entry, identities.has(file.path) ? 'file_unmapped' : 'file_invalid');
      continue;
    }
    if (phaseOfEntry(entry) !== 'importing') queue.enter(entry, 'importing', 'the file is in the library');
    const source = sources.get(file.path);
    if (!file.download && source) {
      file.download = source.download;
      file.association!.originalName = source.download.file;
    }
    entry.importResult = { at: Date.now(), ok: true, method: null, path: file.path, validation: 'basic' };
    queue.endAttempt(entry, 'imported', 'the file is in the library');
    queue.complete(entry, 'file is in the library', file.path);
    done.add(entry.id);
    imported.push(entry.id);
  }

  const picks: (Selection & { association?: MediaFile['association']; source: 'manual' | 'numbering' | 'automatic'; numberingRevision: number })[] = [];
  const taken = new Set<string>();
  const loose: InventoryFile[] = [];
  const open = entries.filter((entry) => !done.has(entry.id) && current(entry));
  const interpretations = new Map<string, ReturnType<typeof inspectCoverage>>();
  const coverageOf = (numbering: ReturnType<typeof numberingOf>) => {
    const key = JSON.stringify(numbering);
    let coverage = interpretations.get(key);
    if (!coverage) {
      coverage = inspectCoverage(folder.files.map((file) => file.path), title, numbering);
      interpretations.set(key, coverage);
    }
    return coverage;
  };

  if (folder.status === 'ok' && open.length) {
    if (title.mediaType === 'movie') {
      // A manual choice identifies the movie. File size cannot select between several plausible videos.
      for (const entry of open) {
        const manual = entry.manualMatch;
        const match = matchMovie(folder.files.map((file) => file.path), manual?.file);
        const file = folder.files.find(({ path }) => path === match.file);
        if (!file) {
          if (folder.files.length) stop(entry, 'file_unmapped');
          continue;
        }
        if (!identities.has(file.path)) {
          stop(entry, 'file_invalid');
          continue;
        }
        const existing = Object.values(db.data.files).find((item) => item.titleKey === title.key && item.path === file.path);
        if (!manual && existing && !approved(existing)) {
          stop(entry, 'file_unmapped');
          continue;
        }
        picks.push({ file, entries: [entry], episodes: [], association: manual ? undefined : existing?.association, source: manual ? 'manual' : 'automatic', numberingRevision: 0 });
        taken.add(file.path);
      }
    } else {
      // A match that the user made comes first, also when the name of the file gives no episode.
      for (const entry of open) {
        const manual = entry.manualMatch;
        if (!manual) continue;
        const file = folder.files.find((item) => item.path === manual.file);
        if (!file || taken.has(file.path)) continue;
        if (!identities.has(file.path)) {
          stop(entry, 'file_invalid');
          continue;
        }
        const covers = manual.covers.filter((cover) => title.episodes.some((episode) => episode.season === cover.season && episode.number === cover.number));
        const covered = open.filter((other) => !done.has(other.id) && covers.some((cover) => cover.season === other.season && cover.number === other.number));
        const list = covered.length ? covered : [entry];
        picks.push({ file, entries: list, episodes: covers.length ? covers : list.map((item) => ({ season: item.season!, number: item.number! })), source: 'manual', numberingRevision: numberingOf(title, entry).revision });
        for (const item of list) done.add(item.id);
        taken.add(file.path);
      }

      for (const file of [...folder.files].sort((a, b) => b.sizeBytes - a.sizeBytes)) {
        if (taken.has(file.path)) continue;
        const existing = Object.values(db.data.files).find((item) => item.titleKey === title.key && item.path === file.path);
        const target = open.find((entry) => !done.has(entry.id) && (existing
          ? approved(existing) && covers(existing.episodes, entry)
          : covers(coverageOf(numberingOf(title, entry)).byFile.get(file.path) ?? [], entry)));
        const numbering = numberingOf(title, target ?? open[0]!);
        const episodes = existing
          ? approved(existing) ? existing.episodes : []
          : coverageOf(numbering).byFile.get(file.path) ?? [];
        // A file that names no episode of the title can not be given to a target. It stays for the choice of the user.
        if (!episodes.length) {
          loose.push(file);
          continue;
        }
        const covered = open.filter((entry) => !done.has(entry.id) && (existing || JSON.stringify(numberingOf(title, entry)) === JSON.stringify(numbering)) && covers(episodes, entry));
        if (!covered.length) continue;
        if (!identities.has(file.path)) {
          for (const entry of covered) stop(entry, 'file_invalid');
          continue;
        }
        picks.push({ file, entries: covered, episodes, association: existing?.association, source: numbering.ranges.length ? 'numbering' : 'automatic', numberingRevision: numbering.revision });
        for (const entry of covered) done.add(entry.id);
        taken.add(file.path);
      }
    }
  }

  const invalid = new Set<string>();
  for (const selection of picks) {
    const abs = join(folder.rootReal!, selection.file.path);
    const info = await stat(abs).catch(() => undefined);
    const real = await realpath(abs).catch(() => undefined);
    const expected = identities.get(selection.file.path);
    if (!expected || !info?.isFile() || !real || !inside(folder.rootReal!, real) || info.size !== expected.sizeBytes
      || info.mtimeMs !== expected.mtimeMs || info.dev !== expected.dev || info.ino !== expected.ino) {
      invalid.add(selection.file.path);
      for (const entry of selection.entries) stop(entry, 'file_invalid');
      continue;
    }
    const origin = sources.get(selection.file.path);
    if (title.mediaType === 'tv' && origin && selection.source !== 'manual' && !selection.association) {
      const coverage = inspectCoverage([origin.download.file], title, numberingOf(title, selection.entries[0]!), parseRelease(origin.torrent.name).season);
      if (selection.entries.some((entry) => !covers(coverage.episodes, entry))) {
        invalid.add(selection.file.path);
        for (const entry of selection.entries) stop(entry, 'file_unmapped');
      }
    }
  }
  // The user can remove the title while the folder and the client are read. A file record must not outlive its title.
  if (db.data.titles[titleKey] !== title) return { imported: [], blocked: [] };
  const counts = new Map<Torrent, number>();
  for (const { file, entries } of picks) {
    const origin = sources.get(file.path);
    if (origin) counts.set(origin.torrent, (counts.get(origin.torrent) ?? 0) + entries.length);
  }
  const now = Date.now();

  for (const selection of picks) {
    if (invalid.has(selection.file.path)) continue;
    const selected = selection.entries.filter(current);
    if (!selected.length) continue;
    const existing = Object.values(db.data.files).find((file) => file.titleKey === title.key && file.path === selection.file.path);
    const file: MediaFile = existing ?? { id: randomUUID(), titleKey: title.key, path: selection.file.path, sizeBytes: 0, mtimeMs: 0, episodes: [], missing: false, addedAt: now };
    const origin = sources.get(selection.file.path);
    Object.assign(file, {
      sizeBytes: selection.file.sizeBytes, mtimeMs: selection.file.mtimeMs, episodes: selection.episodes, missing: false,
      association: selection.association ?? {
        source: selection.source, originalName: origin?.download.file ?? selection.file.path,
        numberingRevision: selection.numberingRevision, identity: identities.get(selection.file.path)!,
      },
    });
    db.data.files[file.id] = file;
    title.folder ??= selection.file.path.split('/')[0]!;
    for (const entry of selected) {
      if (title.mediaType === 'movie') title.fileId = file.id;
      else {
        const episode = episodeOf(title, entry);
        if (episode) episode.fileId = file.id;
      }
      if (origin) {
        const external = !addedByApp(origin.torrent.hash);
        recordTorrent(entry, { ...origin, kind: counts.get(origin.torrent)! > 1 ? 'pack' : 'single', external });
        file.download = { ...origin.download, external };
        file.association!.originalName = origin.download.file;
      }
      if (entry.attempts.at(-1)?.outcome !== 'running') queue.startAttempt(entry, 'imported from the title folder');
      if (phaseOfEntry(entry) !== 'importing') queue.enter(entry, 'importing', 'imported from the title folder');
      entry.importResult = { at: now, ok: true, method: null, path: file.path, validation: 'basic' };
      catalog.info('import_completed', `Import completed: ${file.path}`, itemFields(entry), { path: file.path, method: null, validation: 'basic' });
      queue.endAttempt(entry, 'imported');
      queue.complete(entry, 'imported from the title folder');
      imported.push(entry.id);
    }
  }

  // The client can have the download of a target that the folder does not cover.
  const left = open.filter((entry) => current(entry) && !done.has(entry.id) && !picks.some((selection) => selection.entries.includes(entry)));
  const downloads = localOnly ? { attached: [], blocked: [] } : await attachDownloads({ queue, clients }, title, left);

  // A file that names no episode of a series leaves its targets for the user. The download of the same files would find
  // the same problem, so the target waits in the import instead of downloading a second copy.
  blocked.push(...downloads.blocked);
  const waiting = left.filter((entry) => eligible(entry) && !downloads.attached.includes(entry.id));
  if (title.mediaType === 'tv' && waiting.length && loose.length) {
    for (const entry of waiting) {
      const scoped = loose.filter((file) => file.path.split('/').some((part) => parseRelease(part).season !== null) || new Set(title.episodes.map((episode) => episode.season)).size === 1);
      if (!scoped.length || inspectCoverage(scoped.map((file) => file.path), title, numberingOf(title, entry)).status({ season: entry.season!, number: entry.number! }) === 'absent') continue;
      catalog.warn('import_blocked', 'Import blocked: file_unmapped', itemFields(entry), { code: 'file_unmapped', files: loose.map((file) => file.path) });
      // The import is the step that found the file, so the target waits there for the user.
      stop(entry, 'file_unmapped');
    }
  }
  if (localOnly) {
    for (const entry of waiting) {
      const unknown = loose.length && inspectCoverage(loose.map((file) => file.path), title, numberingOf(title, entry)).status({ season: entry.season!, number: entry.number! }) !== 'absent';
      stop(entry, unknown ? 'file_unmapped' : 'file_not_found');
    }
  }
  return { imported: [...imported, ...downloads.attached], blocked };
}

// The video files of the folder of a title, in the shape of the choice of a file. The paths are the paths of the
// library records, relative to the root.
export async function titleFiles(title: Title): Promise<{ status: 'ok' | 'root_unavailable' | 'none'; files: { rel: string; sizeBytes: number }[] }> {
  const folder = await readTitleFolder(title, { guessedFolder: true });
  if (folder.status === 'root_unavailable') return { status: 'root_unavailable', files: [] };
  if (folder.status !== 'ok') return { status: 'none', files: [] };
  return { status: 'ok', files: folder.files.map((file) => ({ rel: file.path, sizeBytes: file.sizeBytes })) };
}
