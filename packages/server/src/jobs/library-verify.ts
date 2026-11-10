import { type Db, db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import { JobError } from '../core/jobs.ts';
import { withTitleLock } from '../core/title-lock.ts';
import type { Handler } from '../core/worker.ts';
import type { Finder } from '../library/grab/finder.ts';
import type { Clients } from '../library/downloads/client-api.ts';
import { attachTorrent } from '../library/downloads/attach.ts';
import type { Torrent } from '../library/downloads/qbittorrent.ts';
import { ClientError } from '../library/downloads/qbittorrent.ts';
import { isActive, type Queue, type QueueEntry } from '../library/downloads/queue.ts';
import { isMonitored, type Title } from '../library/library.ts';
import { scanTitle } from '../library/scan.ts';
import { verificationOf, type VerificationState } from '../library/verification.ts';
import type { SourceDownload } from '../migration/migration-source.ts';

type Deps = { queue: Queue; clients: Clients; finder: Finder; events: Events };

const present = (fileId: string | null) => Boolean(fileId && db.data.files[fileId] && !db.data.files[fileId]!.missing);
const episodeKey = (season: number, number: number) => `${season}x${number}`;

// The source monitors each episode. The season of the source is only the fallback. A difference becomes an override,
// and an agreement removes an old override, so the source decides the state of the episode it knows.
function applyEpisodes(title: Title, state: VerificationState) {
  for (const source of state.episodes) {
    const episode = title.episodes.find((item) => item.season === source.season && item.number === source.number);
    if (!episode) continue;
    if (!episode.airDate && source.airDateUtc) episode.airDate = source.airDateUtc;
    episode.override = null;
    const natural = isMonitored(title, episode);
    episode.override = natural === source.monitored ? null : source.monitored ? 'monitored' : 'unmonitored';
  }
}

export function libraryVerifyHandler({ queue, clients, finder, events }: Deps): Handler {
  async function verify(key: string, signal: AbortSignal) {
    const title = db.data.titles[key];
    const state = verificationOf(key);
    // The title left the library while the verification waited. Its work goes with it.
    if (!title) {
      delete db.data.verifications[key];
      return;
    }
    if (!state) return;

    // The facts of the title come from the refresh job. The verification waits for them and keeps its work.
    if (title.mediaType === 'tv' && title.episodesLoadedAt === null) throw new JobError('outage', 'The episodes are not loaded yet.');
    if (title.mediaType === 'movie' && title.metaLoadedAt === null) throw new JobError('outage', 'The metadata is not loaded yet.');
    signal.throwIfAborted();

    applyEpisodes(title, state);

    // The folder decides which targets already have a file. The scan must run before the client is read.
    const scan = await scanTitle(key);
    if (scan.status === 'root_unavailable' || scan.status === 'changed') throw new JobError('outage', 'The folder of the title cannot be read.');

    // The torrents that the backup records: only the ones that are still in a client.
    const handles = clients.all();
    const selected = new Map<string, SourceDownload>();
    let torrents = new Map<string, Torrent>();
    if (handles.length) {
      if (title.mediaType === 'movie') {
        const newest = [...state.downloads].sort((a, b) => b.id - a.id)[0];
        if (newest) selected.set('movie', newest);
      } else {
        for (const download of state.downloads) for (const episode of download.episodes) {
          const episodeOf = episodeKey(episode.season, episode.number);
          const current = selected.get(episodeOf);
          if (!current || download.id > current.id) selected.set(episodeOf, download);
        }
      }
      // A hash that another title works with stays with that title.
      const busy = new Set(Object.values(db.data.queue).filter((entry) => entry.titleKey !== key && entry.transferHash && isActive(entry)).map((entry) => entry.transferHash!));
      const hashes = [...new Set([...selected.values()].map((download) => download.hash))].filter((hash) => !busy.has(hash));
      const found = new Map<string, { handle: (typeof handles)[number]; torrent: Torrent }>();
      for (const handle of handles) {
        let list: Torrent[];
        try {
          list = await handle.api.byHashes(hashes);
        } catch (error) {
          // An unknown association is not a missing one. The search waits for the client.
          if (error instanceof ClientError) throw new JobError('outage', 'The download client did not answer.');
          throw error;
        }
        for (const torrent of list) if (!found.has(torrent.hash)) found.set(torrent.hash, { handle, torrent });
      }
      torrents = new Map([...found].map(([hash, item]) => [hash, item.torrent]));
      signal.throwIfAborted();

      // A target for each association that the source monitors and that has no file. The air date stops a search only.
      const byHash = new Map<string, QueueEntry[]>();
      for (const [episodeOf, download] of selected) {
        if (!hashes.includes(download.hash)) continue;
        const torrent = torrents.get(download.hash);
        if (!torrent) continue;
        // The newest event failed and the torrent is not complete. A search is better than a known bad download.
        if (download.failed && !torrent.complete) continue;
        let target: QueueEntry | undefined;
        if (title.mediaType === 'movie') {
          if (title.paused || present(title.fileId)) continue;
          target = queue.ensure(key, null, null);
        } else {
          if (title.paused) continue;
          const episode = title.episodes.find((item) => episodeKey(item.season, item.number) === episodeOf);
          if (!episode || !isMonitored(title, episode) || present(episode.fileId)) continue;
          target = queue.ensure(key, episode.season, episode.number);
        }
        // A target that already works with this torrent keeps its work.
        if (target && !(target.transferHash === download.hash && isActive(target))) byHash.set(download.hash, [...(byHash.get(download.hash) ?? []), target]);
      }
      // The client can answer slowly. The title and its files may have changed, so each target is checked again.
      for (const [hash, targets] of byHash) {
        const item = found.get(hash);
        if (!item || db.data.titles[key] !== title) continue;
        await attachTorrent({ queue }, { handle: item.handle, torrent: item.torrent, targets, cause: 'download found in the backup' });
      }
    }

    // The scan can find the file of a target that still waits. Its old entry is done, so the queue does not show work
    // that the library already has.
    for (const entry of Object.values(db.data.queue)) {
      if (entry.titleKey !== key || !isActive(entry)) continue;
      const hasFile =
        title.mediaType === 'movie'
          ? present(title.fileId)
          : present(title.episodes.find((episode) => episode.season === entry.season && episode.number === entry.number)?.fileId ?? null);
      if (!hasFile) continue;
      queue.endAttempt(entry, 'imported', 'the file is in the library');
      queue.move(entry, { stage: 'available', branch: null, reason: null }, 'file is in the library');
    }

    // A target that the import blocked because its pack lacks the episode, or because the torrent left the client,
    // goes back to the search after a delay.
    finder.repairBlocked(key);

    // Search every target that is still missing, monitored, and aired. An attached torrent holds its target, so it
    // is not searched again.
    if (!title.paused) finder.requestSearch(key, { reason: 'import verification' });

    // A second import can add hashes while this run waits. It keeps the state pending, and the next run reads them.
    const current = verificationOf(key);
    if (current && current.updatedAt === state.updatedAt) current.pending = false;
    events.publish('library.changed', { key });
  }

  return {
    concurrency: 2,
    // A client or a root can stay off for a long time. The periodic sweep starts the pending work again, so the
    // verification never ends because of the retry budget.
    maxAttempts: 1_000_000,
    run: (job, { signal }) => {
      const key = (job.payload as { key: string }).key;
      return withTitleLock(key, () => verify(key, signal));
    },
  };
}
