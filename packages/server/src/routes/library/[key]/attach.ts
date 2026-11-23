import type { RequestHandler } from 'express';
import { db } from '../../../core/db.ts';
import { attachCandidates, attachRefusal, findDownload, HASH, torrentInUse } from '../../../helpers/queue-attach.ts';
import { inspectCoverage } from '../../../library/coverage.ts';
import { attachTorrent } from '../../../library/downloads/attach.ts';
import { ClientError } from '../../../library/downloads/qbittorrent.ts';
import { entryId, isActive } from '../../../library/downloads/queue.ts';
import { parseRelease } from '../../../library/grab/release.ts';
import { presentFile } from '../../../library/imports/plan.ts';
import { isSample, isVideoFile } from '../../../library/parse.ts';
import type { Clients, Queue, Title } from '../../../types.ts';

export function libraryAttachGet(clients: Clients): RequestHandler<{ key: string }> {
  return async (_req, res) => {
    const title = res.locals.title as Title;
    if (title.mediaType !== 'tv') return void res.status(400).json({ error: 'invalid_request' });
    try {
      res.json(await attachCandidates(clients.all(), title.key, true));
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  };
}

export function libraryAttachPost(queue: Queue, clients: Clients): RequestHandler<{ key: string }> {
  return async (req, res) => {
    const title = res.locals.title as Title;
    const { hash } = req.body ?? {};
    if (title.mediaType !== 'tv' || typeof hash !== 'string' || !HASH.test(hash)) return void res.status(400).json({ error: 'invalid_request' });
    try {
      const download = await findDownload({ titleKey: title.key, transferHash: null, clientId: null }, clients, hash);
      if ('error' in download) return void res.status(download.error === 'torrent_not_found' ? 404 : 409).json({ error: download.error });
      const { handle, torrent } = download;
      const videos = (await handle.api.files(hash)).map(({ name }) => name).filter((name) => isVideoFile(name) && !isSample(name));
      if (db.data.titles[title.key] !== title) return void res.status(404).json({ error: 'not_found' });
      if (torrentInUse({ titleKey: title.key }, hash)) return void res.status(409).json({ error: 'torrent_in_use' });
      if (!videos.length) return void res.status(409).json({ error: 'nothing_to_import' });
      const coverage = inspectCoverage(videos, title, title.numbering, parseRelease(torrent.name).season);
      const targets = [];
      let attached = false;
      for (const episode of title.episodes) {
        const status = coverage.status(episode);
        const file = presentFile(episode.fileId);
        if (status === 'absent' || (file && status === 'unknown')) continue;
        const existing = queue.get(entryId(title.key, episode.season, episode.number));
        const refusal = existing && attachRefusal(existing);
        const tracked = existing?.transferHash === hash && existing.clientId === handle.id
          && (['downloading', 'importing'].includes(existing.state.kind) || (existing.state.kind === 'blocked' && refusal));
        if (file?.download?.hash === hash || tracked) {
          attached = true;
          continue;
        }
        if (existing && (existing.state.kind === 'paused' || (isActive(existing) && refusal))) continue;
        const target = existing ?? queue.ensure(title.key, episode.season, episode.number);
        if (!isActive(target)) queue.request(target, 'download attached by the user');
        target.numbering = undefined;
        target.replaceDestination = undefined;
        targets.push(target);
      }
      if (!targets.length && !attached) return void res.status(409).json({ error: 'nothing_to_import' });
      await attachTorrent({ queue }, { ...download, targets, cause: 'download attached by the user', manual: true });
      res.json({ hash });
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  };
}
