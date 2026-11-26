import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../../../../core/db.ts';
import type { QueueGroupPage, QueueMappingEpisode } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { preparedMapping } from '../../../../helpers/queue-attach.ts';
import { bySeasonNumber, filtersOf, groupAggregate, lanePositions, reachedOf, shown, view } from '../../../../helpers/queue.ts';
import { findItem } from '../../../../library/downloads/queue.ts';
import { inside, torrentVideos } from '../../../../library/imports/importer.ts';
import { normalizeNumbering, releasePoint } from '../../../../library/numbering.ts';
import { recoverMappingSources } from '../../../../library/scan.ts';
import type { Clients, ImportStatus, Poller, Title, Torrent } from '../../../../types.ts';

async function identity(path: string) {
  const info = await lstat(path).catch(() => undefined);
  return info?.isFile() ? `${info.dev}:${info.ino}` : undefined;
}

async function mappingOf(title: Title, clients: Clients, fixedSeason: number | null, persist: () => void): Promise<QueueMappingEpisode[]> {
  const numbering = normalizeNumbering(title.numbering);
  const regularSeasons = new Set(title.meta.seasons.filter((season) => season.seasonNumber > 0 && season.episodeCount > 0).map((season) => season.seasonNumber));
  const episodes = fixedSeason === null
    ? title.episodes.filter((episode) => regularSeasons.has(episode.season) && episode.tmdbId > 0 && episode.number > 0 && !episode.removedFromTmdb)
    : title.episodes.filter((episode) => episode.season === fixedSeason);
  const rows = episodes.map(({ season, number, fileId }) => {
    const id = `${title.key}:${season}x${number}`;
    const entry = db.data.queue[id];
    const record = fileId ? db.data.files[fileId] : undefined;
    const releaseSeason = releasePoint(numbering, { season, number })?.season ?? season;
    return { id, season, number, releaseSeason, entry, file: record?.titleKey === title.key && !record.missing ? record : undefined };
  });
  if (fixedSeason === null && await recoverMappingSources(title, rows.flatMap(({ file }) => file ?? []), clients)) await persist();
  const hashes = new Map<string, Set<string>>();
  const add = (id: string | null | undefined, hash: string | null | undefined) => {
    if (id && hash) (hashes.get(id) ?? hashes.set(id, new Set()).get(id)!).add(hash);
  };
  if (fixedSeason === null) for (const { entry, file } of rows) {
    add(entry?.clientId, entry?.transferHash);
    if (!file?.download?.name) add(file?.download?.clientId, file?.download?.hash);
  }
  const handles = new Map(clients.all().filter(({ id }) => hashes.has(id)).map((handle) => [handle.id, handle]));
  const inventory = new Map(await Promise.all([...handles.values()].map(async ({ id, api }) => {
    const torrents = await api.byHashes([...hashes.get(id)!]).catch(() => []);
    return [id, new Map(torrents.map((torrent) => [torrent.hash, torrent]))] as const;
  })));
  const find = (id: string | null | undefined, hash: string | null | undefined) => id && hash ? inventory.get(id)?.get(hash) : undefined;
  const root = db.data.roots[title.rootId]?.path;
  const links = new Map<Torrent, Promise<Set<string | undefined>>>();
  async function linked(clientId: string, torrent: Torrent, path: string) {
    if (!root) return false;
    const abs = join(root, path);
    if (!inside(root, abs)) return false;
    const inode = await identity(abs);
    if (!inode) return false;
    let found = links.get(torrent);
    if (!found) {
      found = torrentVideos(handles.get(clientId)!, torrent).catch(() => undefined)
        .then(async (files) => new Set(await Promise.all((files ?? []).map((file) => identity(file.abs)))));
      links.set(torrent, found);
    }
    return (await found).has(inode);
  }
  const mapping = await Promise.all(rows.map(async ({ id, season, number, releaseSeason, entry, file }) => {
    const prepared = entry && preparedMapping(entry)?.candidate;
    if (prepared && Object.hasOwn(prepared.matches, id)) {
      const manual = Object.entries(prepared.manualMatches ?? {}).find(([, points]) => points.some((point) => point.season === season && point.number === number));
      return { id, season, number, releaseSeason, torrent: { hash: prepared.hash, name: prepared.release.title }, match: manual ? { file: manual[0], path: null } : null };
    }
    const current = find(entry?.clientId, entry?.transferHash);
    const imported = entry?.importResult;
    const origin = file?.download ? (fixedSeason === null && file.download.name ? file.download : find(file.download.clientId, file.download.hash))
      : file && current && entry?.clientId && imported?.ok && imported.path === file.path
        && (imported.method === 'copy' || (imported.method === 'hardlink' && await linked(entry.clientId, current, file.path))) ? current : undefined;
    const manual = entry?.manualMatch?.covers.some((point) => point.season === season && point.number === number) ? entry.manualMatch.file : undefined;
    const torrent = origin ?? (file && entry?.state.kind === 'available' ? undefined : current);
    const saved = !torrent || origin ? file : undefined;
    const name = saved?.download?.file ?? saved?.association?.originalName ?? (saved ? saved.path.split('/').pop() : (torrent || fixedSeason !== null ? manual : undefined));
    return { id, season, number, releaseSeason, torrent: torrent ? { hash: torrent.hash, name: torrent.name ?? torrent.hash } : null, match: name ? { file: name, path: saved?.path ?? null } : null };
  }));
  return mapping.sort((a, b) => a.season - b.season || a.number - b.number);
}

// The episodes of one season of a series, in the order of the season and the number. Without a season, it shows every
// season of the series. `group` covers every member of the season before the tab filter, so the inspector header and
// the row show the same aggregate. `items` holds every episode of the season: the tab of the page filters the rows,
// not the children.
export function queueGroupGet(poller: Poller, importStatus: ImportStatus | undefined, clients: Clients, persist = (): void | Promise<void> => db.write()): RequestHandler<{ titleKey: string }> {
  return async (req, res) => {
    const f = filtersOf(req.query);
    const lane = lanePositions();
    const season = req.query.season === undefined ? null : Number(req.query.season);
    const mappingRequested = req.query.mapping === 'true';
    const all = Object.values(db.data.queue).filter(
      (entry) => entry.titleKey === req.params.titleKey && entry.season !== null && (season === null || entry.season === season) && shown(entry) && (f.cleared || !entry.clearedAt),
    );
    const items = [...all].sort(bySeasonNumber);
    // The download of the group is the part of the least advanced torrent that the client reports.
    let download: number | null = null;
    for (const entry of all) {
      if (entry.state.kind !== 'downloading' || !entry.transferHash) continue;
      const transfer = poller.transfer(entry.transferHash);
      if (!transfer) continue;
      download = download === null ? transfer.progress : Math.min(download, transfer.progress);
    }
    const summary = groupAggregate(items, season !== null ? findItem(req.params.titleKey, season) : undefined);
    const title = db.data.titles[req.params.titleKey];
    const numberingRevision = title?.numbering?.revision ?? 0;
    const mapping = mappingRequested && title ? await mappingOf(title, clients, season, persist) : undefined;
    res.json({
      cursor: db.data.queueRev,
      group: {
        ...summary,
        reached: reachedOf(all),
        download,
      },
      items: items.map((entry) => view(poller, importStatus, entry, lane)),
      ...(mapping ? { mapping, numberingRevision } : {}),
    } satisfies QueueGroupPage);
  };
}
