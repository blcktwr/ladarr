import { join } from 'node:path';
import type { RequestHandler } from 'express';
import { db } from '../../../core/db.ts';
import { titleOf } from '../../../helpers/mapping.ts';
import { fail } from '../../../helpers/rename.ts';
import { evidenceOf, matchContent, type ContentProposal, type ContentRejection, type FileEvidence } from '../../../library/content.ts';
import { readableRoot } from '../../../library/imports/plan.ts';
import type { MappingEntry } from '../../../library/mapping.ts';
import { probeFile } from '../../../library/probe.ts';

type Deps = { probe?: typeof probeFile };

export type ProposalRow = ContentProposal & { fileId: string };

// Reads the files of the title and gives the episodes that the content matching finds for each one. The files of one
// torrent are one pack, and the pack is solved as a whole. It changes nothing.
export function mappingProposal({ probe = probeFile }: Deps = {}): RequestHandler {
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
        packs.set(pack, [...(packs.get(pack) ?? []), evidenceOf(file.path, await probe(join(rootReal, file.path)))]);
      }
      const idOf = new Map(files.map((file) => [file.path, file.id]));
      const proposals: ProposalRow[] = [];
      const rejections: (ContentRejection & { fileId: string })[] = [];
      for (const [, evidences] of [...packs].sort(([a], [b]) => a.localeCompare(b))) {
        const match = matchContent(evidences, title.episodes);
        for (const proposal of match.proposals) proposals.push({ ...proposal, fileId: idOf.get(proposal.path)! });
        for (const rejection of match.rejections) rejections.push({ ...rejection, fileId: idOf.get(rejection.path)! });
      }
      // The mapping that a person can review: the files that matched, and an empty row for the files that need a
      // decision. A row that the person removes stays as it is.
      const entries: MappingEntry[] = [...proposals.map((proposal) => ({ path: proposal.path, episodes: proposal.episodes })), ...rejections.map((rejection) => ({ path: rejection.path, episodes: [] }))];
      res.json({ titleKey, proposals, rejections, entries });
    } catch (error) {
      fail(res, error);
    }
  };
}
