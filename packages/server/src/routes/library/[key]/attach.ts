import type { RequestHandler } from 'express';
import { db } from '../../../core/db.ts';
import { withTitleLock } from '../../../core/title-lock.ts';
import { attachCandidates, attachRefusal, findDownload, HASH, torrentInUse } from '../../../helpers/queue-attach.ts';
import { inspectCoverage } from '../../../library/coverage.ts';
import { attachTorrent } from '../../../library/downloads/attach.ts';
import { ClientError } from '../../../library/downloads/qbittorrent.ts';
import { entryId, isActive, phaseOfEntry } from '../../../library/downloads/queue.ts';
import { parseRelease } from '../../../library/grab/release.ts';
import { presentFile } from '../../../library/imports/plan.ts';
import { draftTitle } from '../../../library/imports/source.ts';
import { isSample, isVideoFile } from '../../../library/parse.ts';
import { addTitle } from '../../../library/tools/add.ts';
import type { Clients, LibraryDeps, Queue } from '../../../types.ts';

const KEY = /^(movie|tv):([1-9]\d*)$/;

export function libraryAttachGet(clients: Clients): RequestHandler<{ key: string }> {
  return async (req, res) => {
    const { key } = req.params;
    const match = KEY.exec(key);
    if (!match || !Number.isSafeInteger(Number(match[2]))) return void res.status(404).json({ error: 'not_found' });
    try {
      res.json(await attachCandidates(clients.all(), key, true));
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  };
}

export function libraryAttachPost(queue: Queue, clients: Clients, { tmdb, events, enqueue }: LibraryDeps, persist?: () => void | Promise<void>): RequestHandler<{ key: string }> {
  return async (req, res) => {
    const { key } = req.params;
    const [, mediaType, rawId] = KEY.exec(key) ?? [];
    const tmdbId = Number(rawId);
    if ((mediaType !== 'movie' && mediaType !== 'tv') || !Number.isSafeInteger(tmdbId)) return void res.status(404).json({ error: 'not_found' });
    const stored = db.data.titles[key];
    const { hash } = req.body ?? {};
    if (typeof hash !== 'string' || !HASH.test(hash)) return void res.status(400).json({ error: 'invalid_request' });
    try {
      const download = await findDownload({ titleKey: key, transferHash: null, clientId: null }, clients, hash);
      if ('error' in download) return void res.status(download.error === 'torrent_not_found' ? 404 : 409).json({ error: download.error });
      const { handle, torrent } = download;
      const videos = (await handle.api.files(hash)).map(({ name }) => name).filter((name) => isVideoFile(name) && !isSample(name));
      if (!videos.length || (mediaType === 'movie' && videos.length !== 1)) return void res.status(409).json({ error: 'nothing_to_import' });
      let title = stored;
      if (!title) {
        if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
        const rootId = db.data.settings.defaultRoots[mediaType];
        if (!rootId || db.data.roots[rootId]?.mediaType !== mediaType) return void res.status(400).json({ error: 'root_required' });
        ({ title } = await draftTitle(tmdb, mediaType, tmdbId, rootId));
      }
      const proposed = title;
      await withTitleLock(key, async () => {
        if (db.data.titles[key] !== stored) return void res.status(stored ? 404 : 409).json({ error: stored ? 'not_found' : 'preview_changed' });
        if (torrentInUse({ titleKey: key }, hash)) return void res.status(409).json({ error: 'torrent_in_use' });
        const movie = proposed.mediaType === 'movie';
        const coverage = movie ? undefined : inspectCoverage(videos, proposed, proposed.numbering, parseRelease(torrent.name).season);
        const selections = [];
        let attached = false;
        for (const episode of movie ? [null] : proposed.episodes) {
          const status = episode && coverage?.status(episode);
          const file = presentFile(episode ? episode.fileId : proposed.fileId);
          if (status === 'absent' || (file && status === 'unknown')) continue;
          const season = episode?.season ?? null;
          const number = episode?.number ?? null;
          const existing = stored ? queue.get(entryId(key, season, number)) : undefined;
          const refusal = existing && attachRefusal(existing);
          const tracked = existing?.transferHash === hash && existing.clientId === handle.id
            && (['downloading', 'importing'].includes(existing.state.kind) || (existing.state.kind === 'blocked' && refusal));
          if (file?.download?.hash === hash || tracked) {
            attached = true;
            continue;
          }
          if (movie && file) continue;
          if (existing && (existing.state.kind === 'paused' || (isActive(existing) && (refusal || (movie && phaseOfEntry(existing) === 'sending'))))) continue;
          selections.push({ season, number, existing });
        }
        if (!selections.length && !attached) return void res.status(409).json({ error: 'nothing_to_import' });
        if (!stored) {
          if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
          const { seriesType, rootId, meta, episodes } = proposed;
          if (db.data.roots[rootId]?.mediaType !== mediaType) return void res.status(400).json({ error: 'root_required' });
          await addTitle({ tmdb, enqueue }, { mediaType, tmdbId, seriesType, rootId, meta, episodes, mode: 'paused', preset: null });
        }
        const cause = 'download attached by the user';
        const targets = selections.map(({ season, number, existing }) => {
          const target = existing ?? queue.ensure(key, season, number);
          if (!isActive(target)) queue.request(target, cause);
          target.numbering = undefined;
          target.replaceDestination = undefined;
          return target;
        });
        await attachTorrent({ queue }, { ...download, targets, cause, manual: true });
        if (!stored) {
          await (persist ? persist() : db.write());
          events.publish('library.changed', { key });
        }
        res.json({ hash });
      });
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  };
}
