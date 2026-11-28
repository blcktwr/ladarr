import type { RequestHandler } from 'express';
import { db } from '../../../../../../core/db.ts';
import { withTitleLock } from '../../../../../../core/title-lock.ts';
import { manualStopsOf, shown } from '../../../../../../helpers/queue.ts';
import { mappingFile, rejectedSource, seasonRejection } from '../../../../../../helpers/queue-releases.ts';
import { ClientError } from '../../../../../../library/downloads/qbittorrent.ts';
import { entryId, isActive, itemFor } from '../../../../../../library/downloads/queue.ts';
import { uploadInUse } from '../../../../../../library/downloads/upload.ts';
import { REJECTION_TEXT } from '../../../../../../library/grab/decide.ts';
import type { RejectedMapping } from '../../../../../../library/grab/finder.ts';
import { isObject } from '../../../../../../library/grab/indexers.ts';
import type { Clients, Finder, IndexerService } from '../../../../../../types.ts';

type Selection = { indexerId: number; guid: string; files: { file: string; ids: string[] }[] };

function selections(value: unknown): Selection[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 100) return;
  const seen = new Set<string>();
  const ids = new Set<string>();
  const result: Selection[] = [];
  for (const torrent of value) {
    if (!isObject(torrent) || typeof torrent.indexerId !== 'number' || !Number.isInteger(torrent.indexerId) ||
      typeof torrent.guid !== 'string' || !torrent.guid || !Array.isArray(torrent.files) || !torrent.files.length) return;
    const key = `${torrent.indexerId}:${torrent.guid}`;
    if (seen.has(key)) return;
    seen.add(key);
    const paths = new Set<string>();
    const files: Selection['files'] = [];
    for (const row of torrent.files) {
      if (!isObject(row) || typeof row.file !== 'string' || !row.file || paths.has(row.file) ||
        !Array.isArray(row.ids) || !row.ids.length || !row.ids.every((id) => typeof id === 'string' && id.length > 0)) return;
      paths.add(row.file);
      for (const id of row.ids) {
        if (ids.has(id) || ids.size >= 1000) return;
        ids.add(id);
      }
      files.push({ file: row.file, ids: row.ids });
    }
    result.push({ indexerId: torrent.indexerId, guid: torrent.guid, files });
  }
  return result;
}

const rejection = (code: string) => ({ error: 'release_rejected', rejections: [{ code, message: REJECTION_TEXT[code] ?? code }] });

function claimedHash(titleKey: string, hash: string) {
  return uploadInUse(titleKey, hash) ||
    Object.values(db.data.queueItems).some(({ selected }) => selected[hash] && selected[hash].status !== 'verify') ||
    Object.values(db.data.queue).some((entry) => isActive(entry) && entry.transferHash === hash && (entry.clientId || entry.release?.uploadPath));
}

export function queueEntryReleaseMapPost(finder: Finder, indexers: IndexerService, clients: Clients): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    if (!entry || !shown(entry) || entry.clearedAt) return void res.status(404).json({ error: 'not_found' });
    const title = db.data.titles[entry.titleKey]!;
    const choices = selections(req.body?.torrents);
    if (!choices || title.mediaType !== 'tv' || entry.season === null) return void res.status(400).json({ error: 'invalid_request' });
    const item = itemFor(entry);
    const revision = item?.revision;
    const numbering = title.numbering?.revision;
    const candidates = choices.map(({ indexerId, guid }) => seasonRejection(entry, indexerId, guid));
    const ids = choices.flatMap(({ files }) => files.flatMap((file) => file.ids));
    const targets = ids.map((id) => ({ id, target: db.data.queue[id], revision: db.data.queue[id]?.revision }));
    const eligible = () => {
      if (item && (item.state.kind === 'paused' || item.state.kind === 'cancelled' || item.state.kind === 'available')) return false;
      const episodes = new Set(title.episodes.filter((episode) => episode.season === entry.season && !episode.removedFromTmdb && finder.wantedEpisode(title, episode))
        .map(({ season, number }) => entryId(title.key, season, number)));
      const claimed = new Set(Object.values(item?.selected ?? {}).filter(({ status }) => status !== 'verify').flatMap(({ matches }) => Object.keys(matches)));
      return targets.every(({ id, target }) => {
        if (!episodes.has(id) || claimed.has(id) || !target || !shown(target) || (item && !item.entryIds.includes(id))) return false;
        if (target.clearedAt || target.titleKey !== title.key || target.season !== entry.season || target.clientId || target.release?.uploadPath) return false;
        if (target.transferHash) return target.state.kind === 'blocked' && target.state.at === 'fetching' && target.state.problem.code === 'file_unmapped' &&
          (!item || item.selected[target.transferHash]?.status === 'verify');
        if (target.state.kind === 'blocked') return ['queued', 'searching', 'fetching'].includes(target.state.at);
        return !target.release && ['queued', 'waiting', 'searching'].includes(target.state.kind);
      });
    };
    if (!candidates.every((candidate) => candidate !== undefined)) return void res.status(404).json({ error: 'release_not_found' });
    if (!eligible()) return void res.status(409).json({ error: 'mapping_conflict' });
    const stops = () => candidates.flatMap((candidate) => manualStopsOf(candidate).filter(({ code }) => code !== 'file_unmapped'));
    const blockers = stops();
    if (blockers.length) return void res.status(409).json({ error: 'release_rejected', rejections: blockers });
    const indexersPresent = () => candidates.every(({ indexerId }) => db.data.indexers[indexerId]?.push.sonarr);
    if (!indexersPresent()) return void res.status(409).json(rejection('indexer_removed'));

    const batch: RejectedMapping[] = [];
    const hashes = new Set<string>();
    for (const [i, candidate] of candidates.entries()) {
      const result = await rejectedSource(entry, candidate, indexers, clients);
      if (!result.evidence) {
        if (result.error.endsWith('_unreachable')) return void res.status(502).json({ error: result.error });
        return void res.status(409).json(rejection(result.error));
      }
      const { evidence } = result;
      const videos = new Set(evidence.files.filter((file) => mappingFile(file)));
      if (!videos.size) return void res.status(409).json(rejection('no_video'));
      const { files } = choices[i]!;
      if (files.some(({ file }) => !videos.has(file))) return void res.status(400).json({ error: 'file_not_in_download' });
      if (hashes.has(evidence.hash)) return void res.status(400).json({ error: 'invalid_request' });
      hashes.add(evidence.hash);
      batch.push({ candidate, evidence, files });
    }

    const client = clients.next();
    try {
      if (client && (await client.api.byHashes([...hashes])).some(({ hash }) => hashes.has(hash))) {
        return void res.status(409).json(rejection('already_downloading'));
      }
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
    await withTitleLock(title.key, async () => {
      if (db.data.queue[entry.id] !== entry || entry.clearedAt || db.data.titles[title.key] !== title || title.numbering?.revision !== numbering ||
        itemFor(entry) !== item || item?.revision !== revision || clients.next() !== client || !eligible() || !indexersPresent() || stops().length ||
        targets.some(({ id, target, revision }) => db.data.queue[id] !== target || target?.revision !== revision) ||
        choices.some(({ indexerId, guid }, i) => seasonRejection(entry, indexerId, guid) !== candidates[i])) {
        return void res.status(409).json({ error: 'mapping_stale' });
      }
      if ([...hashes].some((hash) => claimedHash(title.key, hash))) return void res.status(409).json(rejection('already_downloading'));
      finder.applyRejectedMapping(entry, batch);
      await db.write();
      res.status(202).json({ started: ids });
    });
  };
}
