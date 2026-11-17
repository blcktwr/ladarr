import { db } from '../../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { REJECTION_TEXT } from '../../../../../../library/grab/decide.ts';
import { catalogTargets, shown, titleOf } from '../../../../../../helpers/queue.ts';
import type { Finder, Queue, RawRelease } from '../../../../../../types.ts';

// A release of the last search that the user picks by hand after a no-match. The preferences are skipped, the
// safety checks are not.
export function queueEntryReleaseGrabPost(queue: Queue, finder: Finder): RequestHandler<{ id: string }> {
  return (req, res) => {
    const entry = db.data.queue[req.params.id];
    const { indexerId, guid, ids } = (req.body ?? {}) as { indexerId?: unknown; guid?: unknown; ids?: unknown };
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    if (typeof indexerId !== 'number' || typeof guid !== 'string') return void res.status(400).json({ error: 'invalid_request' });
    const candidate = (entry.search?.rejected ?? []).find((release) => release.indexerId === indexerId && release.guid === guid);
    if (!candidate) return void res.status(404).json({ error: 'release_not_found' });
    const title = titleOf(entry)!;
    const catalog = catalogTargets(title);
    const selected = ids ?? [entry.id];
    if (!Array.isArray(selected) || !selected.length || selected.length > 1000 || !selected.every((id) => typeof id === 'string' && (title.mediaType === 'movie' ? id === entry.id : catalog.some((target) => target.id === id)))) return void res.status(400).json({ error: 'invalid_request' });
    const release: RawRelease = {
      indexerId: candidate.indexerId,
      guid: candidate.guid,
      title: candidate.title,
      link: candidate.link,
      magnet: candidate.magnet,
      infoHash: candidate.infoHash,
      sizeBytes: candidate.sizeBytes,
      publishedAt: null,
      seeders: candidate.seeders,
      peers: null,
      categories: [],
    };
    const want = finder.wantForRelease(title, release, entry.season ?? undefined, entry.number ?? undefined);
    if (!want) {
      const rejections = [{ code: 'not_an_episode', message: REJECTION_TEXT.not_an_episode }];
      return void res.status(409).json({ error: 'release_rejected', rejections });
    }
    const targets: [number | null, number | null][] = [...new Set(selected)].map((id) => {
      if (title.mediaType === 'movie') return [null, null];
      const target = catalog.find((item) => item.id === id)!;
      return [target.season, target.number];
    });
    if (!targets.length) return void res.status(409).json({ error: 'release_rejected', rejections: [{ code: 'wrong_season', message: REJECTION_TEXT.wrong_season }] });
    const entries = targets.map(([season, number]) => queue.ensure(entry.titleKey, season, number));
    const outcome = finder.grabManual(entries, release, want);
    if (!('reserved' in outcome)) return void res.status(409).json({ error: 'release_rejected', rejections: outcome.rejections.map((code) => ({ code, message: REJECTION_TEXT[code] ?? code })) });
    res.status(202).json({ started: entries.map((item) => item.id) });
  };
}
