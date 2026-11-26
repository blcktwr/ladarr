import { basename } from 'node:path';
import { db } from '../../../../../core/db.ts';
import type { QueuePackFiles } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { evidenceOf, matchContent } from '../../../../../library/content.ts';
import { releaseEpisodes } from '../../../../../library/parse.ts';
import { catalogPoint, normalizeNumbering } from '../../../../../library/numbering.ts';
import { probeFile } from '../../../../../library/probe.ts';
import { HASH, matchEntry, matchSource, matchSourceKind, preparedFiles, preparedMapping } from '../../../../../helpers/queue-attach.ts';
import { catalogTargets, label } from '../../../../../helpers/queue.ts';
import type { Clients } from '../../../../../types.ts';

export function queueEntryFilesGet(clients: Clients): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const hash = req.query.hash;
    const entry = matchEntry(req.params.id, hash);
    if (!entry) return void res.status(404).json({ error: 'not_found' });
    const title = db.data.titles[entry.titleKey]!;
    const selectedSource = matchSourceKind(entry, req.query.source, hash);
    if (!selectedSource || (hash !== undefined && (typeof hash !== 'string' || !HASH.test(hash) || selectedSource === 'library'))) return void res.status(400).json({ error: 'invalid_request' });
    const mapping = selectedSource === 'download' ? preparedMapping(entry, hash) : undefined;
    if (hash !== undefined && entry.season === null && !mapping) return void res.status(400).json({ error: 'invalid_request' });
    if (mapping) {
      const files = preparedFiles(mapping.candidate);
      if (!files?.length) return void res.status(409).json({ error: 'download_not_found' });
      const revision = entry.season === null ? null : normalizeNumbering(title.numbering).revision;
      const matches = mapping.candidate.numberingRevision === revision ? mapping.candidate.manualMatches : undefined;
      res.json({
        source: selectedSource,
        sources: ['download'],
        files: files.map((file) => ({ ...file, current: matches?.[file.rel] ?? [] })),
        entries: entry.season === null ? [{ id: entry.id, label: label(entry), season: null, number: null }]
          : catalogTargets(title).filter((target) => target.season === entry.season),
      } satisfies QueuePackFiles);
      return;
    }
    try {
      const source = await matchSource(entry, clients, selectedSource, hash);
      if ('error' in source) return void res.status(409).json({ error: source.error });
      const download = source.download && { hash: source.download.torrent.hash, clientId: source.download.handle.id };
      const records = Object.values(db.data.files).filter((known) => known.titleKey === title.key);
      const recordOf = (rel: string) => records.find((known) => download ? known.download?.hash === download.hash && known.download.clientId === download.clientId && known.association?.originalName === rel : known.path === rel);
      const metadata = await Promise.all(source.files.map(async (file) => evidenceOf(file.rel, await probeFile(file.abs))));
      const map = normalizeNumbering(entry.numbering ?? title.numbering);
      const evidence = source.files.map((file, index) => {
        const item = { ...metadata[index]! };
        const record = recordOf(file.rel);
        const original = record ? record.association?.originalName ?? null : file.rel;
        if (item.season !== null && item.episode !== null) {
          const point = catalogPoint(map, { season: item.season, number: item.episode });
          item.season = point?.season ?? null;
          item.episode = point?.number ?? null;
        }
        const parsed = original ? releaseEpisodes(original, title.episodes, map, entry.season, title.meta.title) : null;
        if (item.season === null && item.episode === null && parsed?.numbers.length === 1) {
          item.season = parsed.season;
          item.episode = parsed.numbers[0]!;
        }
        return item;
      });
      const content = matchContent(evidence, title.episodes);
      const files = source.files.map((file, index) => {
        const record = recordOf(file.rel);
        const manual = Object.values(db.data.queue).filter((other) => other.titleKey === title.key && (!download || (other.transferHash === download.hash && other.clientId === download.clientId)) && other.manualMatch?.file === file.rel).sort((a, b) => (b.manualMatchRevision ?? 0) - (a.manualMatchRevision ?? 0))[0]?.manualMatch;
        const proposal = content.proposals.find((item) => item.path === file.rel);
        const rejection = content.rejections.find((item) => item.path === file.rel);
        const tags = metadata[index]!;
        return {
          rel: file.rel,
          sizeBytes: file.sizeBytes,
          originalName: record?.association?.originalName ?? basename(file.rel),
          location: file.rel,
          source: download ?? (record?.download ? { hash: record.download.hash, clientId: record.download.clientId } : null),
          current: manual?.covers ?? record?.episodes ?? [],
          metadata: { title: tags.title, season: tags.season, episode: tags.episode, durationSeconds: tags.durationSeconds },
          proposal: proposal ? { episodes: proposal.episodes, step: proposal.step, evidence: proposal.evidence } : null,
          rejection: rejection ? { reason: rejection.reason, evidence: rejection.evidence } : null,
        };
      });
      res.json({ source: selectedSource, sources: download || entry.transferHash ? ['download', 'library'] : ['library'], files, entries: catalogTargets(title) } satisfies QueuePackFiles);
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  };
}
