import type { RequestHandler } from 'express';
import { REJECTION_TEXT } from '../../../../../../library/grab/decide.ts';
import type { Finder } from '../../../../../../library/grab/finder.ts';
import type { RawRelease } from '../../../../../../library/grab/torznab.ts';
import type { Db } from '../../../../../../core/db.ts';
import type { Queue } from '../../../../../../library/downloads/queue.ts';
import { shown, titleOf } from '../../../../../../helpers/queue.ts';

// A release of the last search that the user picks by hand after a no-match. The preferences are skipped, the
// safety checks are not.
export function queueEntryReleaseGrabPost(db: Db, queue: Queue, finder: Finder): RequestHandler<{ id: string }> {
  return (req, res) => {
    const entry = db.data.queue[req.params.id];
    const { indexerId, guid } = (req.body ?? {}) as { indexerId?: unknown; guid?: unknown };
    if (!entry || !shown(db, entry)) return void res.status(404).json({ error: 'not_found' });
    if (typeof indexerId !== 'number' || typeof guid !== 'string') return void res.status(400).json({ error: 'invalid_request' });
    const candidate = (entry.search?.rejected ?? []).find((release) => release.indexerId === indexerId && release.guid === guid);
    if (!candidate) return void res.status(404).json({ error: 'release_not_found' });
    const title = titleOf(db, entry)!;
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
    const targets: [number | null, number | null][] =
      want.kind === 'movie' ? [[null, null]] : want.kind === 'episode' ? [[want.season, want.number]] : title.episodes.filter((episode) => episode.season === want.season).map((episode) => [episode.season, episode.number]);
    if (!targets.length) return void res.status(409).json({ error: 'release_rejected', rejections: [{ code: 'wrong_season', message: REJECTION_TEXT.wrong_season }] });
    const entries = targets.map(([season, number]) => queue.ensure(entry.titleKey, season, number));
    const outcome = finder.grabManual(entries, release, want);
    if (!('reserved' in outcome)) return void res.status(409).json({ error: 'release_rejected', rejections: outcome.rejections.map((code) => ({ code, message: REJECTION_TEXT[code] ?? code })) });
    res.status(202).json({ started: entries.map((item) => item.id) });
  };
}
