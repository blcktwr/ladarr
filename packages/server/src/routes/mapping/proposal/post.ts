import { join } from 'node:path';
import type { RequestHandler } from 'express';
import { db } from '../../../core/db.ts';
import { titleOf } from '../../../helpers/mapping.ts';
import { fail } from '../../../helpers/rename.ts';
import { evidenceOf, matchContent } from '../../../library/content.ts';
import { readableRoot } from '../../../library/imports/plan.ts';
import { releaseEpisodes } from '../../../library/parse.ts';
import { probeFile } from '../../../library/probe.ts';
import type { ContentRejection, FileEvidence, MappingEntry, ProposalDeps, ProposalRow } from '../../../types.ts';

// Reads the files of the title and gives the episodes that the content matching finds for each one. The files of one
// torrent are one pack, and the pack is solved as a whole. It changes nothing.
export function mappingProposal({ probe = probeFile }: ProposalDeps = {}): RequestHandler {
  return async (req, res) => {
    const titleKey = titleOf(req.body);
    if (!titleKey) return void res.status(400).json({ error: 'invalid_title' });
    const title = db.data.titles[titleKey];
    if (!title) return void res.status(404).json({ error: 'title_not_found' });
    if (title.mediaType !== 'tv') return void res.status(409).json({ error: 'not_a_series' });
    try {
      const rootReal = await readableRoot(db.data.roots[title.rootId]);
      const files = Object.values(db.data.files)
        .filter((file) => file.titleKey === titleKey && !file.missing)
        .sort((a, b) => a.path.localeCompare(b.path));
      const packs = new Map<string, FileEvidence[]>();
      for (const file of files) {
        const pack = file.download?.hash ?? '';
        const evidence = evidenceOf(file.path, await probe(join(rootReal, file.path)));
        const originalName = file.association?.originalName ?? (file.download || file.source !== undefined ? null : file.path);
        const numbering = Object.values(db.data.queue).find((entry) => entry.titleKey === titleKey && entry.transferHash === file.download?.hash && entry.numbering?.revision === file.association?.numberingRevision)?.numbering ?? title.numbering;
        const parsed = originalName ? releaseEpisodes(originalName, title.episodes, numbering, null, title.meta.title) : undefined;
        if (evidence.season === null && evidence.episode === null && parsed?.numbers.length === 1) {
          evidence.season = parsed.season;
          evidence.episode = parsed.numbers[0]!;
        }
        packs.set(pack, [...(packs.get(pack) ?? []), evidence]);
      }
      const idOf = new Map(files.map((file) => [file.path, file.id]));
      const proposals: ProposalRow[] = [];
      const rejections: (ContentRejection & { fileId: string })[] = [];
      for (const [, evidences] of [...packs].sort(([a], [b]) => a.localeCompare(b))) {
        const match = matchContent(evidences, title.episodes);
        for (const proposal of match.proposals) proposals.push({ ...proposal, fileId: idOf.get(proposal.path)! });
        for (const rejection of match.rejections) rejections.push({ ...rejection, fileId: idOf.get(rejection.path)! });
      }
      // Unresolved files stay outside the request. An empty entry explicitly removes its coverage.
      const entries: MappingEntry[] = proposals.map((proposal) => ({ path: proposal.path, episodes: proposal.episodes }));
      res.json({ titleKey, proposals, rejections, entries });
    } catch (error) {
      fail(res, error);
    }
  };
}
