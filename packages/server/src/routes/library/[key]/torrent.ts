import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { QueueTorrent, TorrentUploadFile } from '@ladarr/shared/types';
import { db } from '../../../core/db.ts';
import { withTitleLock } from '../../../core/title-lock.ts';
import { inspectCoverage } from '../../../library/coverage.ts';
import { ClientError } from '../../../library/downloads/qbittorrent.ts';
import { entryId, forgetSource, isActive, phaseOfEntry } from '../../../library/downloads/queue.ts';
import { enqueueUpload, findUpload, uploadHash, uploadInUse, uploadOwner } from '../../../library/downloads/upload.ts';
import { folderMapping } from '../../../library/grab/folder-mapping.ts';
import { torrentInfo } from '../../../library/grab/torrent.ts';
import { presentFile } from '../../../library/imports/plan.ts';
import { draftTitle } from '../../../library/imports/source.ts';
import { isSample, isVideoFile } from '../../../library/parse.ts';
import { addTitle } from '../../../library/tools/add.ts';
import type { Clients, EpisodeRef, LibraryDeps, Queue, Title } from '../../../types.ts';

const KEY = /^(movie|tv):([1-9]\d*)$/;
const MAX_PREVIEWS = 8;
const PREVIEW_MS = 10 * 60_000;
const episodeKey = ({ season, number }: EpisodeRef) => `${season}:${number}`;
type Preview = { title: Title; draft: boolean; torrent: QueueTorrent; bytes: Buffer; paths: string[]; expires: number; catalog: Map<string, number> };
type Handler = RequestHandler<{ key: string }>;

function proposed(paths: string[], title: Title, folders: boolean): TorrentUploadFile[] {
  const manifest = folders ? undefined : inspectCoverage(paths, title, title.numbering);
  const numeric = folders ? folderMapping(paths, title.episodes) : undefined;
  const files = paths.map((path) => ({
    path,
    episodes: numeric?.get(path) ?? manifest?.byFile.get(path) ?? [],
  }));
  const counts = new Map<string, number>();
  for (const { episodes } of files) {
    for (const episode of episodes) {
      const key = episodeKey(episode);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return files.map(({ path, episodes }) => ({ path, episodes: episodes.filter((episode) => counts.get(episodeKey(episode)) === 1) }));
}

function reviewed(files: unknown, paths: string[], title: Title): TorrentUploadFile[] | undefined {
  if (!Array.isArray(files) || files.length > paths.length) return;
  const catalog = new Map(title.episodes.map((episode) => [episodeKey(episode), episode]));
  const allowed = new Set(paths);
  const taken = new Set<string>();
  const result: TorrentUploadFile[] = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !allowed.delete(file.path) || !Array.isArray(file.episodes)) return;
    const episodes: EpisodeRef[] = [];
    for (const episode of file.episodes) {
      if (!episode || !Number.isSafeInteger(episode.season) || !Number.isSafeInteger(episode.number)) return;
      const key = episodeKey(episode);
      if (!catalog.has(key) || taken.has(key)) return;
      taken.add(key);
      episodes.push({ season: episode.season, number: episode.number });
    }
    result.push({ path: file.path, episodes });
  }
  return result;
}

export function libraryTorrent(queue: Queue, clients: Clients, { tmdb, events, enqueue }: LibraryDeps, persist?: () => void | Promise<void>) {
  const previews = new Map<string, Preview>();

  async function start({ title: proposed, draft, torrent, bytes, catalog: identity }: Preview, files: TorrentUploadFile[]) {
    let title = proposed;
    const expected = draft ? undefined : title;
    const stale = draft ? { status: 409, error: 'preview_changed' } : { status: 404, error: 'not_found' };
    const { hash, name, totalBytes } = torrent;
    return withTitleLock(title.key, async () => {
      if (db.data.titles[title.key] !== expected) return stale;
      if (uploadInUse(title.key, hash)) return { status: 409, error: 'torrent_in_use' };
      const active = draft ? undefined : Object.values(db.data.queue).find((entry) => entry.titleKey === title.key && entry.transferHash === hash && isActive(entry));
      let found;
      try {
        found = await findUpload(clients, hash, active?.clientId);
      } catch (error) {
        if (error instanceof ClientError) return { status: 502, error: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' };
        throw error;
      }
      const { download, handle } = found;
      if (db.data.titles[title.key] !== expected) return stale;
      if (uploadInUse(title.key, hash)) return { status: 409, error: 'torrent_in_use' };
      if (!handle) return { status: 409, error: 'client_missing' };
      const catalog = new Map(title.episodes.map((episode) => [episodeKey(episode), episode]));
      if (files.some(({ episodes }) => episodes.some((episode) => {
        const key = episodeKey(episode);
        return !identity.has(key) || catalog.get(key)?.tmdbId !== identity.get(key);
      }))) return { status: 409, error: 'preview_changed' };
      const selections = files.flatMap(({ path, episodes }) => (title.mediaType === 'movie' ? [null] : episodes).map((episode) => ({ path, episode })));
      const targets = [];
      let replay = 0;
      for (const { path, episode } of selections) {
        const file = presentFile(episode ? catalog.get(episodeKey(episode))!.fileId : title.fileId);
        const current = draft ? undefined : queue.get(entryId(title.key, episode?.season ?? null, episode?.number ?? null));
        if (file) {
          if (file.download?.hash === hash) replay++;
          continue;
        }
        if (current && isActive(current)) {
          const same = uploadHash(current) === hash;
          if (same && current.state.kind !== 'blocked') {
            if (current.release?.uploadPath === path) replay++;
            continue;
          }
          const phase = phaseOfEntry(current);
          const sameLive = download && current.transferHash === hash && current.clientId === handle.id && ['sending', 'downloading'].includes(phase);
          const importing = current.state.kind === 'importing' || (phase === 'importing' && Object.values(db.data.imports).some((journal) => journal.steps.some((step) => step.entryIds.includes(current.id))));
          if (current.state.kind === 'paused' || importing || (!same && !sameLive && (['sending', 'downloading', 'importing'].includes(phase) || (current.release?.uploadPath && current.transferHash)))) {
            if (title.mediaType === 'movie') return { status: 409, error: 'torrent_in_use' };
            continue;
          }
        }
        targets.push({ path, episode, current });
      }
      if (!targets.length) {
        if (!replay) return { status: 409, error: 'nothing_to_import' };
        if (active && uploadHash(active) === hash && !db.data.torrents[hash]) {
          db.data.torrents[hash] = bytes.toString('base64');
          await (persist ? persist() : db.write());
        }
        return { hash, targets: replay };
      }

      if (draft) {
        if (!tmdb) return { status: 503, error: 'metadata_unavailable' };
        if (db.data.roots[title.rootId]?.mediaType !== title.mediaType) return { status: 400, error: 'root_required' };
        const { mediaType, tmdbId, seriesType, rootId, meta, episodes } = title;
        ({ title } = await addTitle({ tmdb, enqueue }, { mediaType, tmdbId, seriesType, rootId, meta, episodes, mode: 'paused', preset: null }));
      }
      const owner = download ? uploadOwner(title.key, hash, handle.id) : undefined;
      const savedUpload = Object.values(db.data.queue).some((entry) => entry.titleKey === title.key && isActive(entry) && uploadHash(entry) === hash && entry.source)
        ? db.data.torrents[hash] : undefined;
      const entries = targets.map(({ path, episode, current }) => {
        const entry = current ?? queue.ensure(title.key, episode?.season ?? null, episode?.number ?? null);
        forgetSource(entry);
        if (!isActive(entry)) queue.request(entry, 'torrent uploaded');
        else queue.retryAttempt(entry, 'torrent uploaded');
        Object.assign(entry, {
          search: null, transferHash: hash, clientId: handle.id, source: { torrent: true }, manualMatch: null,
          importTries: 0, importResult: null, replaceDestination: undefined, partialPack: null, continuation: null,
          numbering: structuredClone(title.numbering ?? null),
          release: {
            guid: `uploaded:${hash}`, indexerId: 0, indexerName: 'Upload torrent', title: name, sizeBytes: totalBytes,
            infoHash: hash, link: null, magnet: null, kind: title.mediaType === 'movie' ? 'single' : 'pack',
            seeders: null, manual: true, external: !owner, uploadPath: path, uploadOwner: owner,
          },
        });
        const attempt = entry.attempts.at(-1);
        if (attempt) attempt.release = name;
        const phase = download ? download.torrent.complete ? 'importing' : 'downloading' : 'waiting_slot';
        queue.resolve(entry, phase, 'torrent uploaded', name);
        queue.touch(entry);
        return entry;
      });
      db.data.torrents[hash] = savedUpload ?? bytes.toString('base64');
      if (!download) enqueueUpload(enqueue, entries, hash);
      else if (download.torrent.complete) enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });
      await (persist ? persist() : db.write());
      if (draft) events.publish('library.changed', { key: title.key });
      return { hash, targets: entries.length };
    });
  }

  const upload: Handler = async (req, res) => {
    const [, mediaType, rawId] = KEY.exec(req.params.key) ?? [];
    const id = Number(rawId);
    if ((mediaType !== 'movie' && mediaType !== 'tv') || !Number.isSafeInteger(id)) return void res.status(404).json({ error: 'not_found' });
    const stored = db.data.titles[req.params.key];
    if (!req.is('application/x-bittorrent')) return void res.status(415).json({ error: 'invalid_torrent' });
    if (req.query.method !== undefined && req.query.method !== 'folders') return void res.status(400).json({ error: 'invalid_request' });
    let torrent: QueueTorrent;
    try {
      torrent = torrentInfo(req.body, true);
    } catch {
      return void res.status(400).json({ error: 'invalid_torrent' });
    }
    const paths = torrent.files.filter(({ path, sizeBytes }) => sizeBytes > 0 && isVideoFile(path) && !isSample(path)).map(({ path }) => path);
    if (!paths.length || (mediaType === 'movie' && paths.length !== 1)) return void res.status(422).json({ error: 'nothing_to_import' });
    let title = stored;
    if (!title) {
      if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
      const rootId = db.data.settings.defaultRoots[mediaType];
      if (!rootId || db.data.roots[rootId]?.mediaType !== mediaType) return void res.status(400).json({ error: 'root_required' });
      ({ title } = await draftTitle(tmdb, mediaType, id, rootId));
    }
    const preview = { torrent, title, draft: !stored, bytes: req.body as Buffer, paths, expires: Date.now() + PREVIEW_MS, catalog: new Map(title.episodes.map((episode) => [episodeKey(episode), episode.tmdbId])) };
    if (title.mediaType === 'movie') {
      const result = await start(preview, [{ path: paths[0]!, episodes: [] }]);
      return void res.status('status' in result ? result.status : 200).json(result);
    }
    for (const [version, stored] of previews) if (stored.expires <= Date.now() || (stored.title.key === title.key && stored.torrent.hash === torrent.hash)) previews.delete(version);
    if (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value!);
    const version = randomUUID();
    previews.set(version, preview);
    const catalog = title.episodes.map(({ season, number, name }) => ({ season, number, name }));
    res.json({ hash: torrent.hash, version, files: proposed(paths, title, req.query.method === 'folders'), catalog });
  };

  const apply: Handler = async (req, res) => {
    const key = req.params.key;
    const { hash, version, files } = req.body ?? {};
    const preview = typeof version === 'string' ? previews.get(version) : undefined;
    if (!KEY.test(key) || (!db.data.titles[key] && !(preview?.draft && preview.title.key === key))) return void res.status(404).json({ error: 'not_found' });
    if (!preview || preview.title.key !== key || hash !== preview.torrent.hash || preview.expires <= Date.now()) return void res.status(409).json({ error: 'preview_changed' });
    const selections = reviewed(files, preview.paths, preview.title);
    if (!selections) return void res.status(400).json({ error: 'invalid_request' });
    const result = await start(preview, selections);
    res.status('status' in result ? result.status : 200).json(result);
  };

  return { upload, apply };
}
