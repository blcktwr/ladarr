import { db, profilesFor } from '../../core/db.ts';
import { randomUUID } from 'node:crypto';
import { languageOfRegion } from '../../core/languages.ts';
import { episodeEligibleAt } from '../../core/dates.ts';
import { absoluteNumber, bestOf, compareDecisions, compareRejected, decide, explainDecision, REJECTION_TEXT, rejectionSummary, topRejections } from './decide.ts';
import { indexerName, indexersFor, notUsedReason, seedLimits } from './indexers.ts';
import { explainProfile } from './quality.ts';
import { enqueue as enqueueJob, JobError, prioritize } from '../../core/jobs.ts';
import { isMonitored, movieEligibleAt } from '../library.ts';
import { catalog, itemFields, titleFields } from '../../core/log.ts';
import { entryId, forgetSource, forgetUnusedSource, isActive, newTurn, phaseOfEntry, seasonHasCoverage } from '../downloads/queue.ts';
import { createClients } from '../downloads/client-api.ts';
import { importLocal } from '../imports/local.ts';
import { normalizeTitle, parseRelease } from './release.ts';
import { manualUpgradeTargets } from './upgrades.ts';
import { fileOf as matchedFile, matchCompletePack, matchEpisode, matchMovie, matchPartialPack, needsManualMapping, readCoverage, readPackCoverage, validMatches } from './match.ts';
import { readSource, type Evidence } from './source.ts';
import { detach } from './detach.ts';
import { currentSelection, enqueueSelection, readySelection, reasonOf as grabReasonOf, sendPhase } from './grab.ts';
import { requestIdFor } from '../../core/outbound.ts';
import type { OutsideTitleLock } from '../../core/title-lock.ts';
import { catalogPoint, catalogSeasons, normalizeNumbering, releasePoint, releaseSeasons } from '../numbering.ts';
import { needsOtherSeasons } from '@ladarr/shared/queue';
import { DEFAULT_RELEASE_DAY_MINUTES } from '@ladarr/shared/indexers';
import type { DecideContext, Decision, Episode, FinderDeps, Indexer, Job, Numbering, QueueEntry, QueueTorrent, QueueTurn, RawRelease, RejectedRelease, ReleaseRef, Scope, SearchPayload, SearchQuery, SearchState, Title, TitleName, Want } from '../../types.ts';
import type { IndexerApp } from '@ladarr/shared/enums';

class StaleAcquisition extends Error {}

export type RejectedMapping = {
  candidate: RejectedRelease;
  evidence: Evidence;
  files: { file: string; ids: string[] }[];
};

// The reason of the attempt that the manual search of the other seasons of the releases starts. A target that a lost
// job leaves behind continues in that mode, not in a normal search.
export const OTHER_SEASONS_REASON = 'search other seasons';

// How long a waiting entry waits before the next search. The RSS sync finds new releases in between.
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const RESEARCH_MS = 12 * HOUR_MS;
const episodeOf = (title: Title, entry: QueueEntry) => title.episodes.find((episode) => episode.season === entry.season && episode.number === entry.number);
const releaseAt = (title: Title, entry: QueueEntry) =>
  title.mediaType === 'movie' ? movieEligibleAt(title) : episodeEligibleAt(episodeOf(title, entry)?.airDate ?? null);
const isReleaseDay = (release: number | null, at: number) => release !== null && release <= at && at < release + DAY_MS;
const isOverdue = (release: number | null, at: number) => release === null || at >= release + DAY_MS;
const releaseDayInterval = (indexer: Indexer) => (indexer.releaseDayMinutes ?? DEFAULT_RELEASE_DAY_MINUTES) * 60_000;
const nextSearchAt = (release: number | null, indexer: Indexer, last: number) => {
  if (release !== null && release > last) return release;
  return last + (isReleaseDay(release, last) ? releaseDayInterval(indexer) : RESEARCH_MS);
};
function nextRetryAt(title: Title, entries: QueueEntry[], indexers: Indexer[], last: number) {
  return Math.min(...entries.map((entry) => {
    const release = releaseAt(title, entry);
    return Math.min(...indexers.map((indexer) => nextSearchAt(release, indexer, entry.lastIndexerSearch?.[indexer.id] ?? last)));
  }));
}
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 200;
// The most search requests that one automatic search run sends for one title. A run that reaches the budget leaves
// the rest of its work for the next run.
const SEARCH_BUDGET = 12;
// The wait before the next run of a search that the budget stopped. The cache of the first queries is still valid,
// so the next run continues from them without a new request.
const SEARCH_CONTINUE_MS = 1_000;

const present = (fileId: string | null) => Boolean(fileId && db.data.files[fileId] && !db.data.files[fileId]!.missing);
// Ties the log line of a search to the requests that answered it, in the app log and in the request log.
const newRequestId = () => `req-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const releaseKey = (release: Pick<ReleaseRef, 'indexerId' | 'guid'>) => `${release.indexerId}:${release.guid}`;
const unique = (releases: RejectedRelease[]) => [...new Map(releases.map((release) => [releaseKey(release), release])).values()];
type Acquisition = SearchPayload & {
  episodeRound?: boolean;
  // The search that follows a change of the season map.
  remapped?: boolean;
  supplied?: RawRelease[];
  forced?: boolean;
  upgrade?: string;
  work?: {
    id: string;
    revision: number;
    replies: Record<string, RawRelease[]>;
    // For a partial pack, `lacks` holds the targets that it does not have, and `matches` the file of each one that it has.
    checked: Record<string, { decision: Decision; entries: string[]; lacks?: string[]; matches?: Record<string, string> }>;
    packs: Record<string, string>;
    magnet?: { key: string; source: { magnet: string } };
  };
};
const rawOf = (release: ReleaseRef): RawRelease => ({
  indexerId: release.indexerId, guid: release.guid, title: release.title, link: release.link, magnet: release.magnet,
  infoHash: release.infoHash, sizeBytes: release.sizeBytes, seeders: release.seeders, peers: null, publishedAt: null, categories: [],
});

export function createFinder({ queue, indexers, enqueue, clients = createClients(), now = Date.now }: FinderDeps) {
  const cache = new Map<string, { at: number; releases: RawRelease[]; round?: string }>();
  // Equal queries that run at the same time share one request.
  const inflight = new Map<string, { requestId: string; releases: Promise<RawRelease[]> }>();

  // --- What ladarr wants -------------------------------------------------------------------

  const aired = (episode: Episode) => {
    const at = episodeEligibleAt(episode.airDate);
    return at !== null && at <= now();
  };

  const wantedEpisode = (title: Title, episode: Episode) => !title.paused && isMonitored(title, episode) && aired(episode) && !present(episode.fileId);

  function wantedMovie(title: Title) {
    if (title.paused || present(title.fileId)) return false;
    const at = movieEligibleAt(title);
    return at !== null ? at <= now() : title.manualRelease;
  }

  function decideContext(manual = false): DecideContext {
    const hashes = new Set<string>();
    for (const entry of Object.values(db.data.queue)) if (entry.transferHash && entry.clientId && isActive(entry) && phaseOfEntry(entry) !== 'queued') hashes.add(entry.transferHash);
    return {
      settings: db.data.settings,
      quality: db.data,
      indexers: db.data.indexers,
      downloading: (hash) => hashes.has(hash),
      hasFile: (episode) => present(episode.fileId),
      hasMovieFile: (title) => present(title.fileId),
      coverage: (release) => db.data.releaseCoverage[`${release.indexerId}:${release.guid}`] ?? null,
      now: now(),
      manual,
    };
  }

  // --- Requests ---------------------------------------------------------------------------

  // The search jobs of one season of a title. A job that waits for its next search keeps its place in the queue,
  // so the page shows the future work before the worker starts it. The manual search of the other seasons of the
  // releases is a mode of its own, so a normal search never takes it or joins it.
  const sameSearch = (job: Job, payload: SearchPayload) => {
    if (job.type !== 'queue.search' || job.state === 'failed') return false;
    const current = job.payload as SearchPayload | null;
    return current?.titleKey === payload.titleKey && current.season === payload.season && Boolean(current.otherSeasons) === Boolean(payload.otherSeasons);
  };

  // Puts a search in the queue, or joins the search of the same season that waits already. A waiting job holds
  // every target that still needs the search, so a new target does not wait for a second job.
  // `afterRun` keeps the next search of a running job in the queue while that job finishes.
  // The mode of a search keeps its jobs apart: a normal search, a manual search of one target, and the manual search of
  // the other seasons of the releases never move the same target at the same time.
  function enqueueSearch(payload: Acquisition, { runAt = Date.now(), afterRun = false }: { runAt?: number; afterRun?: boolean } = {}): Job {
    const item = queue.findItem(payload.titleKey, payload.season);
    if (item) {
      payload = { ...payload, itemId: item.id };
      if (item.state.kind === 'blocked' && payload.fresh && payload.entryIds.some((id) => {
        const entry = queue.get(id);
        return entry?.state.kind === 'queued' && entry.attempts.at(-1)?.reason === 'retry';
      })) {
        const retrying = payload.entryIds.filter((id) => queue.get(id)?.state.kind === 'queued');
        queue.updateItem(item, { candidate: null, emptySearches: Object.fromEntries(Object.entries(item.emptySearches).filter(([id]) => !retrying.includes(id))) });
        queue.transitionItem(item, { kind: 'queued' });
      }
    }
    const modeOf = (other: Acquisition) => `${Boolean(other.otherSeasons)}|${Boolean(other.manual)}|${Boolean(other.forced)}|${other.upgrade ?? ''}`;
    const mode = modeOf(payload);
    // A manual target leaves the waiting automatic search of its season. The manual job owns it now, so the two jobs
    // cannot move the same target at the same time.
    if (payload.manual || payload.otherSeasons) {
      for (const job of Object.values(db.data.jobs)) {
        if (job.type !== 'queue.search' || job.state !== 'waiting') continue;
        const other = job.payload as SearchPayload;
        if (other.manual || other.otherSeasons || other.titleKey !== payload.titleKey || other.season !== payload.season) continue;
        const rest = other.entryIds.filter((id) => !payload.entryIds.includes(id));
        if (rest.length === other.entryIds.length) continue;
        if (!rest.length) delete db.data.jobs[job.id];
        else job.payload = { ...other, entryIds: rest, resume: undefined };
      }
    }
    const active = Object.values(db.data.jobs).filter((job) => sameSearch(job, payload));
    const waiting = active.filter((job) => job.state === 'waiting' && modeOf(job.payload as SearchPayload) === mode);
    if (waiting.length) {
      // An older copy can hold targets that the first job does not. All of them go in one job.
      waiting.sort((a, b) => a.runAt - b.runAt || a.seq - b.seq);
      const [primary, ...duplicates] = waiting as [Job, ...Job[]];
      const current = primary.payload as Acquisition;
      const ids = new Set<string>();
      for (const item of [current, ...duplicates.map((job) => job.payload as SearchPayload), payload]) for (const id of item.entryIds) ids.add(id);
      const entryIds = [...ids];
      const fresh = Boolean(current.fresh || payload.fresh || duplicates.some((job) => (job.payload as SearchPayload).fresh));
      const manual = Boolean(current.manual || payload.manual || duplicates.some((job) => (job.payload as SearchPayload).manual));
      const otherSeasons = Boolean(current.otherSeasons || payload.otherSeasons || duplicates.some((job) => (job.payload as SearchPayload).otherSeasons));
      // A continuation is valid only for the same targets. A new target starts the search from the first phase. A fresh
      // search starts from the first phase too, because the user asked for the search from the top.
      const sameTargets = current.entryIds.length === ids.size && current.entryIds.every((id) => ids.has(id));
      // A continuation can share a job with later retries: those targets stay asleep when it runs.
      const resume = payload.fresh ? undefined : sameTargets ? (payload.resume ?? current.resume) : runAt < primary.runAt ? payload.resume : undefined;
      const merged: Acquisition = {
        ...current, ...payload, entryIds, ...(resume ? { resume } : {}), ...(manual ? { manual: true } : {}),
      };
      if (current.supplied && payload.supplied) merged.supplied = [...new Map([...current.supplied, ...payload.supplied].map((release) => [releaseKey(release), release])).values()];
      if ((!sameTargets || payload.fresh) && !payload.work) delete merged.work;
      if (!resume) delete merged.resume;
      if (!manual) delete merged.manual;
      if (otherSeasons) merged.otherSeasons = true;
      if (!otherSeasons) delete merged.otherSeasons;
      if (fresh) merged.fresh = true;
      if (!fresh) delete merged.fresh;
      primary.payload = merged;
      primary.runAt = Math.min(primary.runAt, runAt);
      for (const job of duplicates) delete db.data.jobs[job.id];
      if (entryIds.some((id) => db.data.queue[id]?.priority != null)) prioritize(primary.id);
      return primary;
    }
    if (!afterRun) {
      // A search that runs now covers its targets. Only a target that it does not hold needs a second job.
      const running = active.find((job) => job.state === 'running' && modeOf(job.payload as SearchPayload) === mode);
      if (running) {
        const current = running.payload as SearchPayload;
        const missing = payload.entryIds.filter((id) => !current.entryIds.includes(id));
        if (!missing.length) return running;
        payload = { ...payload, entryIds: missing, resume: undefined };
      }
    }
    return enqueue({ type: 'queue.search', payload, runAt, priority: payload.entryIds.some((id) => db.data.queue[id]?.priority != null) });
  }

  function restartSearch(entries: QueueEntry[]) {
    const turns = new Map<QueueTurn, string[]>();
    for (const entry of entries) {
      const item = queue.restart(entry);
      const ids = turns.get(item) ?? [];
      ids.push(entry.id);
      turns.set(item, ids);
    }
    for (const [item, entryIds] of turns) {
      for (const job of Object.values(db.data.jobs)) {
        if (job.type !== 'queue.search' || job.state === 'failed') continue;
        const prior = job.payload as Acquisition;
        if (prior.titleKey !== item.titleKey || prior.season !== item.season) continue;
        const rest = prior.forced ? prior.entryIds.filter((id) => !entryIds.includes(id)) : [];
        if (prior.forced && rest.length === prior.entryIds.length) continue;
        delete db.data.jobs[job.id];
        if (rest.length) enqueueSearch({ ...prior, entryIds: rest, work: undefined, resume: undefined }, { runAt: job.runAt, afterRun: true });
      }
      enqueueSearch({ titleKey: item.titleKey, season: item.season, entryIds, fresh: true }, { afterRun: true });
    }
  }

  // Puts the targets in the queue and starts their search. A target that is in the journey already is left as it is.
  // `only` takes the targets of that set, so a search that the sweep starts does not touch a target that is not due.
  // Returns the entries that the request started.
  function requestSearch(titleKey: string, { season, number, reason = 'search requested', fresh = false, manual = false, only, remapped = false }: { season?: number; number?: number; reason?: string; fresh?: boolean; manual?: boolean; only?: ReadonlySet<string>; remapped?: boolean } = {}): QueueEntry[] {
    const title = db.data.titles[titleKey];
    if (!title) return [];
    const started: QueueEntry[] = [];
    const bySeason = new Map<number, QueueEntry[]>();

    // Opens the target for this search, and makes its entry when it has none. It returns undefined when the target is not due.
    const open = (targetSeason: number | null, targetNumber: number | null): QueueEntry | undefined => {
      if (only && !only.has(entryId(titleKey, targetSeason, targetNumber))) return undefined;
      const entry = queue.ensure(titleKey, targetSeason, targetNumber);
      if (remapped) {
        if (entry.state.kind === 'cancelled' || entry.state.kind === 'paused') return;
        if (entry.state.kind === 'blocked') {
          queue.retryAttempt(entry, 'episode season changed');
          const item = queue.itemFor(entry);
          const verify = item && Object.values(item.selected).some((source) => source.status === 'verify');
          if (!verify) Object.assign(entry, { release: null, transferHash: null, clientId: null, source: null, manualMatch: null, importResult: null, importTries: 0, numbering: title.numbering });
          queue.resolve(entry, verify ? 'fetching' : 'queued', 'episode season changed');
          return entry;
        }
        if (entry.state.kind === 'waiting' || entry.state.kind === 'queued') entry.numbering = title.numbering;
      }
      // An entry that waits for a release searches again now. Any other active entry already has work.
      if (entry.state.kind === 'waiting') {
        const item = queue.itemFor(entry);
        if (item?.state.kind === 'waiting') {
          if (!fresh && !manual && !remapped && (item.nextAt ?? 0) > now()) return;
          queue.transitionItem(item, { kind: 'queued' });
        }
        queue.enter(entry, 'queued', reason);
        return entry;
      }
      return queue.request(entry, reason) ? entry : undefined;
    };

    if (title.mediaType === 'movie') {
      if (manual || wantedMovie(title)) {
        const entry = open(null, null);
        if (entry) started.push(entry);
      }
    } else {
      // The searches of a series start at the first season and its first episode, whatever the order of the
      // episodes of the title. The queue reads this order in the jobs.
      const episodes = [...title.episodes].sort((a, b) => a.season - b.season || a.number - b.number);
      for (const episode of episodes) {
        if ((season !== undefined && episode.season !== season) || (number !== undefined && episode.number !== number)) continue;
        if (!wantedEpisode(title, episode)) continue;
        const entry = open(episode.season, episode.number);
        if (!entry) continue;
        started.push(entry);
        bySeason.set(episode.season, [...(bySeason.get(episode.season) ?? []), entry]);
      }
    }

    if (title.mediaType === 'movie') {
      if (started.length) enqueueSearch({ titleKey, season: null, entryIds: started.map((e) => e.id), fresh, ...(manual ? { manual } : {}) });
    } else {
      for (const [seasonNumber, entries] of bySeason) {
        const item = queue.findItem(titleKey, seasonNumber);
        const retained = item && remapped ? Object.values(item.selected).filter((source) =>
          source.status !== 'accepted' && source.status !== 'uncertain' && source.numberingRevision !== numberingOf(title).revision) : [];
        if (item && remapped && retained.length) {
          queue.transitionItem(item, { kind: 'fetching' });
          queue.updateItem(item, { selected: { ...item.selected, ...Object.fromEntries(retained.map((source) => [source.hash, { ...source, status: 'verify' }])) } });
        } else if (item && remapped && item.state.kind === 'blocked') queue.transitionItem(item, { kind: 'queued' });
        enqueueSearch({ titleKey, season: seasonNumber, entryIds: entries.map((e) => e.id), fresh, ...(manual ? { manual } : {}),
          ...(remapped ? { episodeRound: false, remapped: true } : {}),
          ...(retained.length ? { supplied: retained.map(({ release }) => rawOf(release)) } : {}) });
      }
    }
    return started;
  }

  // --- Queries ----------------------------------------------------------------------------

  const app = (title: Title): IndexerApp => (title.mediaType === 'movie' ? 'radarr' : 'sonarr');

  function categoriesOf(indexer: Indexer, title: Title) {
    const push = indexer.push[app(title)]!;
    return title.seriesType === 'anime' && push.animeCategories.length ? push.animeCategories : push.categories;
  }

  // The indexers that can answer: the indexer manager pushed them for this media type, ladarr uses them, they allow automatic search, and they are not in a backoff.
  function usableIndexers(title: Title) {
    return indexersFor(title.mediaType).filter((indexer) => {
      const push = indexer.push[app(title)]!;
      return !notUsedReason(indexer, app(title)) && push.enableAutomaticSearch;
    });
  }

  function rescheduleReleaseDay(changed: Indexer) {
    const at = now();
    for (const job of Object.values(db.data.jobs)) {
      if (job.type !== 'queue.search' || job.state !== 'waiting') continue;
      const payload = job.payload as Acquisition;
      if (payload.fresh || payload.supplied || payload.work) continue;
      const item = queue.findItem(payload.titleKey, payload.season);
      const title = db.data.titles[payload.titleKey];
      if (!title || item?.state.kind !== 'waiting' || !item.search) continue;
      const entries = item.entryIds.map(queue.get).filter((entry): entry is QueueEntry =>
        !!entry && entry.state.kind === 'waiting' && !prepared(item, entry.id));
      if (!entries.some((entry) => isReleaseDay(releaseAt(title, entry), at))) continue;
      const usable = usableIndexers(title);
      if (!usable.includes(changed)) continue;
      // Older queue records have only the time of the last round.
      for (const entry of entries) entry.lastIndexerSearch ??= Object.fromEntries(usable.map(({ id }) => [id, item.search!.at]));
      const nextAt = Math.max(at, nextRetryAt(title, entries, usable, item.search.at));
      job.runAt = nextAt;
      item.search.nextAt = nextAt;
      for (const entry of entries) if (entry.search) entry.search.nextAt = nextAt;
      queue.updateItem(item, { nextAt });
    }
  }

  // The title and the original title come first. They go to every indexer: only the aliases carry a language. The aliases
  // come after them, and a search uses them only when the names before gave no result.
  const titleNames = (title: Title): TitleName[] => {
    const seen = new Set<string>();
    const fresh = (name: string, least: number) => Boolean(name) && normalizeTitle(name).length >= least && !seen.has(normalizeTitle(name)) && Boolean(seen.add(normalizeTitle(name)));
    const names: TitleName[] = [
      { value: title.meta.title, alias: false, languages: [] },
      { value: title.meta.originalTitle, alias: false, languages: [] },
    ].filter((name) => fresh(name.value, 0));
    // A very short alias, or one in a script that release names do not use, only gives noise.
    const latin = (name: string) => /[a-z]{3}/i.test(name);
    const aliases: TitleName[] = title.meta.aliases
      .filter((name) => latin(name) && fresh(name, 3))
      .map((value) => ({ value, alias: true, languages: [...new Set((title.meta.aliasRegions?.[value] ?? []).map(languageOfRegion))] }));
    return [...names, ...aliases];
  };

  function queryFor(indexer: Indexer, title: Title, scope: Scope, name: string): SearchQuery {
    const caps = indexer.caps;
    const categories = categoriesOf(indexer, title);
    const supports = (mode: string[] | null | undefined, param: string) => Boolean(mode?.includes(param));
    if (scope.kind === 'movie') {
      if (caps?.movie) {
        return {
          kind: 'movie',
          q: name,
          year: title.meta.year ?? undefined,
          imdbId: supports(caps.movie, 'imdbid') ? (title.meta.imdbId ?? undefined) : undefined,
          tmdbId: supports(caps.movie, 'tmdbid') ? title.tmdbId : undefined,
          categories,
        };
      }
      return { kind: 'search', q: title.meta.year ? `${name} ${title.meta.year}` : name, categories };
    }
    if (scope.kind === 'absolute') return { kind: 'search', q: `${name} ${scope.number}`, categories };
    if (caps?.tv) {
      return {
        kind: 'tv',
        q: name,
        season: scope.season,
        ep: scope.kind === 'episode' ? scope.number : undefined,
        tvdbId: supports(caps.tv, 'tvdbid') ? (title.meta.tvdbId ?? undefined) : undefined,
        imdbId: supports(caps.tv, 'imdbid') ? (title.meta.imdbId ?? undefined) : undefined,
        categories,
      };
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    return { kind: 'search', q: `${name} S${pad(scope.season)}${scope.kind === 'episode' ? `E${pad(scope.number)}` : ''}`, categories };
  }

  const pad = (n: number) => String(n).padStart(2, '0');

  // The part of the title that the query asked for. A line says it, so the number of releases means something.
  const scopeText = (scope: Scope, name: string) => {
    if (scope.kind === 'movie') return `"${name}"`;
    if (scope.kind === 'season') return `"${name}" season ${scope.season}`;
    if (scope.kind === 'absolute') return `"${name}" episode ${scope.number} by its absolute number`;
    return `"${name}" S${pad(scope.season)}E${pad(scope.number)}`;
  };

  // Asks every usable indexer at the same time. Each one answers on its own: one failure does not stop the others.
  // `budget` counts the requests that go to an indexer, not the answers from the cache. A query that the budget stops
  // is incomplete, so the caller leaves its targets for the next run instead of ending them as an empty search.
  async function queryAll(title: Title, scope: Scope, name: TitleName, entries: QueueEntry[], signal: AbortSignal, { fresh = false, round, quiet = false, budget, due, releaseDay = false }: { fresh?: boolean; round?: string; quiet?: boolean; budget?: { left: number }; due?: Indexer[]; releaseDay?: boolean } = {}) {
    const usable = usableIndexers(title);
    // An indexer with preferred languages receives only an alias in one of them. No languages means every name.
    const list = usable.filter((indexer) => {
      if (due && !due.includes(indexer)) return false;
      const preferred = indexer.preferredLanguages ?? [];
      return name.languages.length === 0 || preferred.length === 0 || name.languages.some((language) => preferred.includes(language));
    });
    const nameOf = (indexer: Indexer) => indexer.push[app(title)]?.name ?? `indexer ${indexer.id}`;
    // A query for a whole season covers the group, so it makes one line. A query for one episode makes a line in the log
    // of that episode.
    const note = (level: 'info' | 'warn', event: string, message: string, fields: Record<string, unknown>) => {
      if (scope.kind === 'season') catalog[level](event, message, titleFields(title), { ...fields, season: scope.season, episodes: entries.length, covers: entries.map((entry) => entry.id), ...(name.alias ? { languages: name.languages } : {}) });
      else for (const entry of entries) catalog[level](event, message, itemFields(entry), { ...fields, ...(name.alias ? { languages: name.languages } : {}) });
    };
    const state: SearchState = entries[0]?.search ?? { at: now(), indexers: [], candidates: 0, accepted: 0, result: null, topRejections: [], nextAt: null, rejected: [] };
    const searches = entries.map((entry) => ({ entry, search: entry.search }));
    const report = (patch: (search: SearchState) => void) => {
      for (const saved of searches) {
        const { entry } = saved;
        if (db.data.queue[entry.id] !== entry || db.data.titles[title.key] !== title || saved.search !== entry.search) continue;
        entry.search ??= structuredClone(state);
        saved.search = entry.search;
        patch(entry.search);
        queue.touch(entry);
      }
    };
    const skipped = indexersFor(title.mediaType).filter((indexer) => !usable.includes(indexer));
    report((search) => {
      for (const indexer of list) {
        if (!search.indexers.some((item) => item.id === indexer.id)) search.indexers.push({ id: indexer.id, name: indexer.push[app(title)]!.name, state: 'waiting', count: null });
      }
      for (const indexer of skipped) if (!search.indexers.some((item) => item.id === indexer.id)) search.indexers.push({ id: indexer.id, name: indexer.push[app(title)]!.name, state: 'skipped', count: null });
    });

    const releases: RawRelease[] = [];
    let answered = 0;
    let incomplete = false;
    const requests: { indexer: string; requestId: string | null; cached: boolean }[] = [];
    await Promise.all(
      list.map(async (indexer) => {
        const set = (patch: Partial<SearchState['indexers'][number]>) => report((search) => Object.assign(search.indexers.find((item) => item.id === indexer.id)!, patch));
        if (!indexers.usable(indexer)) {
          const problem = indexer.health.error ?? 'the indexer is not usable';
          set({ state: 'skipped', error: problem });
          return note('warn', 'search', `${nameOf(indexer)} skipped: ${problem}`, { indexer: nameOf(indexer), state: 'skipped', scope: scopeText(scope, name.value), error: problem });
        }
        let requestId: string | null = null;
        try {
          let found: RawRelease[];
          // A cache hit makes no request, so the line stays without an id.
          // The query needs the caps of the indexer, so the first search of an indexer asks for them.
          if (!indexer.caps) {
            if (budget && budget.left <= 0) {
              incomplete = true;
              set({ state: 'skipped', error: 'request budget reached' });
              return;
            }
            requestId = requestIdFor(indexerName(indexer));
            await indexers.caps(indexer, { signal, requestId });
            if (searches.length && !searches.some(({ entry, search }) => db.data.queue[entry.id] === entry && db.data.titles[title.key] === title && entry.search === search)) return;
          }
          const query = queryFor(indexer, title, scope, name.value);
          const key = JSON.stringify([indexer.id, query]);
          const hit = cache.get(key);
          let cached = false;
          const cacheMs = releaseDay ? Math.min(CACHE_MS, releaseDayInterval(indexer)) : CACHE_MS;
          if (hit && (!fresh || (round !== undefined && hit.round === round)) && now() - hit.at < cacheMs) {
            found = hit.releases;
            cached = true;
          } else {
            let shared = inflight.get(key);
            if (!shared) {
              // A request that the budget does not allow waits for the next run.
              if (budget && budget.left <= 0) {
                incomplete = true;
                set({ state: 'skipped', error: 'request budget reached' });
                return;
              }
              if (budget) budget.left--;
              const id = requestId ?? requestIdFor(indexerName(indexer));
              shared = { requestId: id, releases: indexers.search(indexer, query, { signal, requestId: id }).finally(() => inflight.delete(key)) };
              inflight.set(key, shared);
            }
            requestId = shared.requestId;
            found = await shared.releases;
            cache.set(key, { at: now(), releases: found, round });
            if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
          }
          answered++;
          releases.push(...found);
          requests.push({ indexer: nameOf(indexer), requestId, cached });
          set({ state: 'done', count: found.length, error: undefined });
          if (!quiet) note('info', 'search', `Indexer returned ${found.length} ${found.length === 1 ? 'release' : 'releases'} for ${scopeText(scope, name.value)}`, { indexer: nameOf(indexer), state: 'done', scope: scopeText(scope, name.value), count: found.length, ...(requestId ? { requestId } : {}) });
        } catch (error) {
          if (signal.aborted) throw error;
          const problem = error instanceof Error ? error.message : 'The indexer did not answer.';
          set({ state: 'failed', error: problem });
          note('warn', 'search', `${nameOf(indexer)} failed: ${problem}`, { indexer: nameOf(indexer), state: 'failed', scope: scopeText(scope, name.value), error: problem, ...(requestId ? { requestId } : {}) });
        }
      }),
    );
    signal.throwIfAborted();
    const unique = new Map(releases.map((release) => [`${release.indexerId}:${release.guid}`, release]));
    return { releases: [...unique.values()], answered, asked: list.length, incomplete, requests };
  }

  // --- Search -----------------------------------------------------------------------------

  const numberingOf = (title: Title): Numbering => normalizeNumbering(title.numbering);

  // The release coordinate that a target asks the indexers for. Null when a saved range gives that release coordinate
  // to another episode, so the target needs an explicit range before it can search.
  const releaseTarget = (numbering: Numbering, entry: QueueEntry) => (entry.season === null || entry.number === null ? null : releasePoint(numbering, { season: entry.season, number: entry.number }));

  function refFor(title: Title, decision: Pick<Decision, 'kind' | 'hash'> & { release: RawRelease | RejectedRelease }, manual: boolean): ReleaseRef {
    const { release } = decision;
    const indexer = db.data.indexers[release.indexerId];
    return {
      guid: release.guid, indexerId: release.indexerId, indexerName: indexer?.push[app(title)]?.name ?? 'Indexer',
      title: release.title, sizeBytes: release.sizeBytes, infoHash: decision.hash, link: release.link, magnet: release.magnet,
      kind: decision.kind, seeders: release.seeders, manual, seed: indexer ? seedLimits(indexer, app(title), decision.kind === 'pack') : null,
    };
  }

  const released = (entry: QueueEntry) => Boolean(entry.clientId && entry.transferHash) || entry.state.kind === 'importing';
  const prepared = (item: QueueTurn, id: string) => Object.values(item.selected).some((source) =>
    (source.status === 'accepted' || currentSelection(item, source)) && Object.hasOwn(source.matches, id));
  const eligibleEntry = (entry: QueueEntry) => isActive(entry) && entry.state.kind !== 'paused' && entry.state.kind !== 'blocked' &&
    (!entry.release?.uploadPath || Boolean(entry.retryDownload)) && !released(entry) &&
    !(entry.transferHash && queue.itemFor(entry)?.selected[entry.transferHash]?.sendMapped && sendPhase(entry));
  const busyTransfer = (item: QueueTurn) => (item.state.kind === 'importing' || item.state.kind === 'downloading') && item.entryIds.some((id) => {
    const entry = queue.get(id);
    return entry && isActive(entry) && released(entry);
  });

  function sendPrepared(item: QueueTurn) {
    enqueueSelection(item, enqueue);
  }

  function rejectionRow(decision: Decision): RejectedRelease {
    const { release } = decision;
    const sizeCode = decision.rejections.find((code) => code === 'size_below_min' || code === 'size_above_max');
    const limit = sizeCode === 'size_above_max' ? decision.limits?.max : decision.limits?.min;
    const manifestProblem = decision.rejections.find((code): code is 'file_unmapped' | 'pack_partial' => code === 'file_unmapped' || code === 'pack_partial');
    return {
      indexerId: release.indexerId, guid: release.guid, title: release.title, link: release.link, magnet: release.magnet,
      infoHash: decision.hash, sizeBytes: release.sizeBytes, seeders: release.seeders, kind: decision.kind,
      resolution: decision.parsed.resolution, source: decision.parsed.source,
      reasons: decision.rejections.map((code) => REJECTION_TEXT[code] ?? code),
      sizeRejection: sizeCode && limit != null && decision.mibPerMinute !== null ? { code: sizeCode, limit, value: decision.mibPerMinute } : null,
      ...(manifestProblem ? { manifestProblem } : {}),
    };
  }

  async function acquire(payload: Acquisition, signal: AbortSignal, final: boolean, outside: OutsideTitleLock) {
    const title = db.data.titles[payload.titleKey];
    const item = queue.findItem(payload.titleKey, payload.season);
    if (item && (item.state.kind === 'importing' || item.state.kind === 'downloading') && !busyTransfer(item)) queue.transitionItem(item, { kind: 'queued' });
    if (!title || title.paused || !item || !['queued', 'waiting', 'searching', 'fetching'].includes(item.state.kind)) return;
    if (item.state.kind === 'waiting' && (item.nextAt ?? 0) > now()) return;
    const numbering = numberingOf(title);
    const revision = numbering.revision;
    const stale = item.season === null ? [] : Object.values(item.selected).filter((source) =>
      source.status === 'prepared' && source.numberingRevision !== revision);
    if (stale.length) {
      const supplied = [...stale.map(({ release }) => rawOf(release)), ...(payload.supplied ?? [])];
      payload.supplied = [...new Map(supplied.map((release) => [releaseKey(release), release])).values()];
      queue.updateItem(item, { selected: { ...item.selected, ...Object.fromEntries(stale.map((source) => [source.hash, { ...source, status: 'verify' }])) } });
    }
    if (item.state.kind === 'fetching' && payload.episodeRound && payload.supplied) {
      const supplied = new Set(payload.supplied.map(releaseKey));
      for (const source of Object.values(item.selected)) {
        if (source.status !== 'verify' || !supplied.has(releaseKey(source.release))) continue;
        for (const id of Object.keys(source.matches)) {
          const entry = queue.get(id);
          if (entry?.state.kind === 'blocked' && ['file_unmapped', 'coverage_unknown', 'numbering_required'].includes(entry.state.problem.code) && !released(entry)) {
            queue.resolve(entry, 'fetching', 'read torrent files');
          }
        }
      }
    }
    const resumed = payload.work?.revision === revision;
    const work = resumed ? payload.work! : (payload.work = { id: randomUUID(), revision, replies: {}, checked: {}, packs: {} });
    const manualIds = payload.forced ? new Set(payload.entryIds) : null;
    const members = item.entryIds.map(queue.get).filter((entry): entry is QueueEntry =>
      !!entry && eligibleEntry(entry) && (!manualIds || manualIds.has(entry.id)));
    if (!members.length) return;
    const alive = () => db.data.titles[title.key] === title && !title.paused && queue.getItem(item.id) === item &&
      numberingOf(title).revision === revision && (item.state.kind === 'searching' || item.state.kind === 'fetching');
    const targets = () => members.filter((entry) => queue.get(entry.id) === entry && eligibleEntry(entry));
    const missing = () => targets().filter((entry) => !prepared(item, entry.id));
    // The rejected releases stay on the list while the search runs, for the manual mapping.
    const earlier = item.search?.rejected ?? [];
    // A rejected partial pack also stays after a round that does not search the packs again.
    const earlierPacks = earlier.filter(({ manifestProblem, kind }) => manifestProblem === 'pack_partial' && kind === 'pack');
    const searchState: SearchState = (resumed && (manualIds ? members[0]?.search : item.search)) ||
      { at: now(), indexers: [], candidates: 0, accepted: 0, result: null, topRejections: [], nextAt: null, rejected: earlier };
    const phase = (kind: 'searching' | 'fetching', entries: QueueEntry[]) => {
      queue.transitionItem(item, { kind });
      for (const entry of entries) {
        if (kind === 'searching' && entry.state.kind === 'queued' && entry.attempts.at(-1)?.reason === 'found by RSS') continue;
        queue.enter(entry, kind, kind === 'searching' ? 'search started' : 'read torrent files');
      }
    };
    if (item.state.kind === 'queued' || item.state.kind === 'waiting') phase('searching', missing());
    if (!manualIds) queue.updateItem(item, { search: searchState });
    for (const entry of members) entry.search = searchState;
    if (!resumed && !payload.upgrade) {
      await importLocal({ queue, clients }, { titleKey: title.key, entryIds: members.map((entry) => entry.id) });
      if (!alive()) return;
      const localBlock = members.find((entry) => entry.state.kind === 'blocked');
      if (localBlock?.state.kind === 'blocked') {
        queue.transitionItem(item, localBlock.state);
        return;
      }
      for (const entry of targets()) {
        if (!entry.retryDownload || !entry.release?.uploadPath) continue;
        forgetSource(entry);
        entry.release = null;
        queue.touch(entry);
      }
    }

    const ctx = decideContext(payload.forced === true);
    const names = titleNames(title);
    const budget = payload.manual || payload.forced || payload.otherSeasons || title.mediaType === 'movie' ? undefined : { left: SEARCH_BUDGET };
    let incomplete = false;
    let unavailable = false;
    const usable = usableIndexers(title);
    const noIndexers = usable.length === 0;
    const releaseDates = new Map(members.map((entry) => [entry, releaseAt(title, entry)]));
    const releaseToday = members.some((entry) => isReleaseDay(releaseDates.get(entry)!, searchState.at));
    // Keep the due indexers fixed through the season, episode and alias queries of this round.
    const dueFor = new Map(members.map((entry) => [entry, usable.filter((indexer) => {
      const last = entry.lastIndexerSearch?.[indexer.id];
      return !releaseToday || payload.fresh || last === undefined || nextSearchAt(releaseDates.get(entry)!, indexer, last) <= searchState.at;
    })]));
    let holdingClient = false;
    const episodeRound = payload.episodeRound || (!resumed && !payload.supplied && targets().some((entry) => prepared(item, entry.id)))
      || missing().every((entry) => entry.retryDownload?.absent);
    let episodeName = names[0];
    const searchesPacks = !payload.forced && ((targets().length > 1 && !episodeRound) || Boolean(payload.otherSeasons));

    const ask = async (scope: Scope, group: QueueEntry[]) => {
      if (!group.length || !alive()) return [];
      const due = usable.filter((indexer) => group.some((entry) => dueFor.get(entry)!.includes(indexer)));
      if (!noIndexers && !due.length) return [];
      const namesToAsk = scope.kind === 'episode' && !payload.manual && !payload.otherSeasons ? (episodeName ? [episodeName] : [])
        : scope.kind === 'absolute' ? names.slice(0, 1) : names;
      const returned = (name: TitleName, releases: RawRelease[]) => {
        if (scope.kind === 'season' && releases.length) episodeName = name;
        return releases;
      };
      for (const name of namesToAsk) {
        const key = JSON.stringify([scope, name.value]);
        if (Object.hasOwn(work.replies, key)) {
          const releases = work.replies[key]!;
          if (releases.length) return returned(name, releases);
          continue;
        }
        if (budget && budget.left <= 0) {
          incomplete = true;
          break;
        }
        phase('searching', group.filter((entry) => !prepared(item, entry.id)));
        const answer = await outside(() => queryAll(title, scope, name, group, signal, { fresh: payload.fresh, round: work.id, budget, quiet: scope.kind !== 'movie', due, releaseDay: releaseToday }));
        if (!alive()) return [];
        incomplete ||= answer.incomplete;
        if (!answer.incomplete && answer.asked > answer.answered) unavailable = true;
        if (scope.kind !== 'movie') {
          const kind = scope.kind === 'season' ? 'season' : 'episode';
          const label = `Search ${name.alias ? 'alias' : kind} ${kind === 'season' ? `"${name.value}"` : scopeText(scope, name.value)}`;
          const count = answer.releases.length;
          const report = (group: QueueEntry[]) => {
            const decisions = candidates(answer.releases, group).map(({ decision }) => decision);
            const accepted = decisions.filter((decision) => decision.accepted).length;
            const detail = `${count} ${count === 1 ? 'result' : 'results'} found, ${accepted} matched quality`;
            return { detail, fields: {
              source: kind, name: name.value, releases: count, accepted, season: scope.kind === 'absolute' ? group[0]!.season : scope.season,
              requests: answer.requests, run: work.id, reasons: rejectionSummary(decisions),
              ...(name.alias ? { languages: name.languages } : {}), ...(answer.incomplete ? { incomplete: true } : {}),
            } };
          };
          if (kind === 'season') {
            const { detail, fields } = report(group);
            catalog.info('search', `${label}: ${detail}`, titleFields(title), fields);
          }
          for (const entry of group) {
            const { detail, fields } = report([entry]);
            const target = kind === 'season' ? ` for S${pad(entry.season!)}E${pad(entry.number!)}` : '';
            catalog.info('search', `${label}${target}: ${detail}`, itemFields(entry), { ...fields, number: entry.number });
          }
        }
        if (answer.incomplete) break;
        if (answer.asked > 0 && answer.asked === answer.answered) {
          work.replies[key] = answer.releases;
          queue.touch(group[0]!);
        }
        if (answer.releases.length) return returned(name, answer.releases);
      }
      return [];
    };

    const point = (entry: QueueEntry) => ({ season: entry.season!, number: entry.number! });
    // The season packs that are known not to hold a target that asked. They are rejected without a new read.
    const lacked = new Map<string, { decision: Decision; entries: string[]; lacks: string[]; matches: Record<string, string> }>();
    // The file of each episode of the season that a release has.
    const held = (fileAt: (target: { season: number; number: number }) => string | null | undefined) =>
      Object.fromEntries(item.entryIds.flatMap((id) => {
        const entry = queue.get(id);
        const file = entry && fileAt(point(entry));
        return file ? [[id, file] as const] : [];
      }));
    const wantForPack = (release: RawRelease, group: QueueEntry[]): Want => ({
      kind: 'season', title, season: group[0]!.season!, releaseSeason: parseRelease(release.title).season ?? group[0]!.season!, numbering,
    });
    const candidates = (releases: RawRelease[], group: QueueEntry[]) => {
      const result: { decision: Decision; want: Want }[] = [];
      for (const release of new Map(releases.map((release) => [releaseKey(release), release])).values()) {
        if (title.mediaType === 'movie') {
          const want: Want = { kind: 'movie', title, ...(payload.upgrade ? { upgradeQuality: payload.upgrade } : {}) };
          result.push({ decision: decide(release, want, ctx), want });
          continue;
        }
        const parsed = parseRelease(release.title);
        if (parsed.pack || parsed.multiSeason) {
          const want = wantForPack(release, group);
          const decision = decide(release, want, ctx, { inspect: true });
          const known = ctx.coverage(release);
          const matched = Object.values(item.selected).some((source) => source.manualMatches && releaseKey(source.release) === releaseKey(release));
          // A record without the files can only skip a pack that has none of the group. The search reads the others again.
          const lacks = payload.forced || matched || known?.titleKey !== title.key || known.numberingRevision !== revision ||
            (!known.files && group.some((entry) => entry.season === known.season && known.numbers.includes(entry.number!)))
            ? [] : group.filter((entry) => !prepared(item, entry.id) && entry.season === known.season && !known.numbers.includes(entry.number!));
          if (lacks.length) {
            const key = releaseKey(release);
            const seen = lacked.get(key);
            lacked.set(key, { decision: { ...decision, accepted: false, rejections: ['pack_partial'] },
              entries: [...new Set([...(seen?.entries ?? []), ...group.map(({ id }) => id)])],
              lacks: [...new Set([...(seen?.lacks ?? []), ...lacks.map(({ id }) => id)])],
              matches: held((target) => target.season === known!.season ? known!.files?.[target.number] : undefined) });
            continue;
          }
          if (decision.covers.some((covered) => group.some((entry) => entry.season === covered.season && entry.number === covered.number)) ||
            parsed.season === null || group.some((entry) => releaseTarget(numbering, entry)?.season === parsed.season) || payload.forced) result.push({ decision, want });
          continue;
        }
        const options = group.map((entry) => {
          const want: Want = { kind: 'episode', title, season: entry.season!, number: entry.number!, numbering,
            ...(payload.upgrade ? { upgradeQuality: payload.upgrade } : {}) };
          return { decision: decide(release, want, ctx), want };
        });
        const best = options.sort((a, b) => a.decision.rejections.length - b.decision.rejections.length)[0]!;
        if (best.decision.covers.length || payload.forced) result.push(best);
      }
      return result.sort((a, b) => compareDecisions(a.decision, b.decision));
    };

    function explain(decision: Decision, entry: QueueEntry, indexer?: string) {
      return explainDecision(decision, {
        profiles: profilesFor(ctx.quality, title!), indexer: indexer ?? db.data.indexers[decision.release.indexerId]?.push[app(title!)]?.name ?? 'Indexer',
        year: title!.meta.year, season: entry.season, number: entry.number, audioLanguage: ctx.settings.audio?.language ?? null,
      });
    }

    function keep(source: QueueTorrent, entries: QueueEntry[], decision: Decision, data?: Buffer) {
      const selected = { ...item!.selected };
      const { release, hash } = source;
      const covers = entries.map(({ id }) => id);
      const profiles = profilesFor(ctx.quality, title!).map(explainProfile);
      for (const entry of entries) {
        const previous = entry.transferHash;
        if (previous && previous !== source.hash && selected[previous]?.status === 'prepared') {
          const { [entry.id]: _, ...matches } = selected[previous]!.matches;
          if (Object.keys(matches).length) selected[previous] = { ...selected[previous]!, matches };
          else delete selected[previous];
          forgetSource(entry);
        }
        Object.assign(entry, { release: source.release, source: source.source, transferHash: source.hash, numbering: title!.mediaType === 'movie' ? null : numbering });
        delete entry.retryDownload;
        const attempt = entry.attempts.at(-1);
        if (attempt) attempt.release = source.release.title;
        catalog.info('release_chosen', `Chose "${release.title}" from ${release.indexerName}`, itemFields(entry), {
          ...explain(decision, entry, release.indexerName), kind: release.kind, manual: release.manual, infoHash: hash, covers, profiles,
        });
        queue.enter(entry, 'fetching', 'release verified', source.release.title);
      }
      if (data) db.data.torrents[source.hash] = data.toString('base64');
      const previous = selected[source.hash];
      selected[source.hash] = { ...source, matches: { ...(previous?.status === 'prepared' ? previous.matches : {}), ...source.matches } };
      queue.updateItem(item!, { selected });
    }

    const inspect = async (list: ReturnType<typeof candidates>, group: QueueEntry[], packScope?: string) => {
      for (const { decision, want } of list) {
        if (!alive()) return;
        const key = releaseKey(decision.release);
        const applicable = () => group.filter((entry) => queue.get(entry.id) === entry && eligibleEntry(entry) && (packScope !== undefined || !prepared(item, entry.id)));
        const remaining = applicable();
        if (!remaining.length) return;
        if (remaining.every((entry) => entry.retryDownload?.absent && entry.retryDownload.hash === decision.hash)) continue;
        const previous = Object.values(item.selected).find((source) => releaseKey(source.release) === key);
        const retrying = payload.fresh && remaining.some((entry) => entry.retryDownload !== undefined);
        if (work.checked[key] || (previous?.status === 'prepared' && !manualIds && !retrying)) continue;
        const evidenceTargets = decision.kind === 'pack' ? remaining : remaining.filter((entry) => entry.number === null ||
          decision.covers.some((covered) => covered.season === entry.season && covered.number === entry.number));
        if (!evidenceTargets.length && !payload.forced) continue;
        const record = (value: Decision, affected = evidenceTargets) => {
          work.checked[key] = { decision: value, entries: affected.map((entry) => entry.id) };
          queue.touch(remaining[0]!);
        };
        if (!decision.accepted) {
          record(decision);
          continue;
        }
        const retained = previous && ((previous.status === 'verify' && (!retrying || manualIds)) || (manualIds && previous.status === 'prepared')) ? previous : undefined;
        const ref = retained?.release ?? refFor(title, decision, payload.forced === true);
        phase('fetching', evidenceTargets.filter((entry) => !prepared(item, entry.id)));
        for (const entry of evidenceTargets) if (!prepared(item, entry.id)) entry.release = ref;
        queue.updateItem(item, { candidate: ref });
        const itemSearch = item.search;
        const current = (evidenceTargets.length ? evidenceTargets : remaining).map((entry) => ({
          entry, attempt: entry.attempt, search: entry.search, release: entry.release, state: entry.state,
        }));
        const requireCurrent = () => {
          signal.throwIfAborted();
          if (!alive() || item.candidate !== ref || item.search !== itemSearch ||
            (retained && item.selected[retained.hash] !== retained) ||
            current.some(({ entry, attempt, search, release, state }) =>
              queue.get(entry.id) !== entry || !eligibleEntry(entry) || entry.attempt !== attempt ||
              entry.search !== search || entry.release !== release || entry.state !== state)) throw new StaleAcquisition();
        };
        const saved = retained?.source && ('magnet' in retained.source ? { ...retained.source, files: retained.manifest }
          : db.data.torrents[retained.hash] ? { torrent: Buffer.from(db.data.torrents[retained.hash]!, 'base64') } : undefined);
        const downloaded = retained?.source && !saved
          ? { problem: 'invalid_torrent' }
          : await outside(() => readSource(ref, db.data.indexers[ref.indexerId], indexers, clients, signal,
            work.magnet?.key === key ? work.magnet.source : saved || undefined)).catch((error: unknown) => {
            requireCurrent();
            const problem = grabReasonOf(error);
            const stop = final || (error instanceof JobError && error.kind === 'invalid_input');
            if (stop) queue.transitionItem(item, { kind: 'blocked', at: 'fetching', problem });
            for (const { entry } of current) {
              if (entry.state.kind !== 'fetching' || entry.release !== ref) continue;
              if (stop) queue.block(entry, problem, 'torrent metadata read failed');
              else queue.observe(entry, 'retry torrent metadata read', problem.code);
            }
            throw error;
          });
        requireCurrent();
        if ('waiting' in downloaded) {
          work.magnet = { key, source: downloaded.waiting };
          holdingClient = true;
          queue.holdClient(item, true);
          enqueueSearch(payload, { afterRun: true });
          return;
        }
        delete work.magnet;
        queue.holdClient(item, false);
        const reject = (code: string, affected?: QueueEntry[]) => record({ ...decision, accepted: false, rejections: [code] }, affected);
        if ('problem' in downloaded) {
          reject(downloaded.problem);
          continue;
        }
        const { evidence } = downloaded;
        const conflicting = Object.values(db.data.queue).some((entry) => entry.titleKey !== title.key && isActive(entry) &&
          entry.transferHash === evidence.hash && (entry.release?.uploadPath || released(entry)));
        if (conflicting) {
          reject('already_downloading');
          continue;
        }
        const candidates = applicable().filter((entry) => !(entry.retryDownload?.absent && entry.retryDownload.hash === evidence.hash));
        if (!candidates.length) continue;
        const movieChoice = title.mediaType === 'movie' && retained ? retained.matches[candidates[0]?.id ?? ''] : null;
        const movie = title.mediaType === 'movie' ? matchMovie(evidence.files, movieChoice) : null;
        if (movie?.problem === 'no_video') {
          reject(movie.problem, candidates);
          continue;
        }
        const manualMatches = retained?.numberingRevision === revision ? retained.manualMatches : undefined;
        if (manualMatches && !validMatches(evidence.files, title, manualMatches)) {
          reject('file_unmapped', candidates);
          continue;
        }
        const pack = decision.kind === 'pack';
        const manifest = title.mediaType === 'movie' ? null
          : pack && decision.parsed.pack && decision.parsed.season !== null
            ? readPackCoverage(evidence.files, title, numbering, decision.parsed.season, manualMatches)
            : readCoverage(evidence.files, title, numbering, manualMatches);
        const requested = candidates.map(point);
        const complete = manifest && pack && matchCompletePack(manifest, requested);
        const partial = manifest && pack ? matchPartialPack(manifest, requested) : null;
        const ambiguous = manifest ? needsManualMapping(manifest, pack ? requested : evidenceTargets.map(point)) : null;
        const chosen = manifest === null ? candidates : candidates.filter((entry) =>
          pack ? partial?.covered.some(({ season, number }) => season === entry.season && number === entry.number)
            : matchEpisode(manifest, point(entry)));
        if (ambiguous || movie?.problem === 'file_unmapped') {
          if (retained?.status === 'verify' || (!retained && !Object.values(item.selected).some((value) => value.status === 'verify'))) {
            const source = 'torrent' in evidence.source ? { torrent: true as const } : evidence.source;
            if ('torrent' in evidence.source) db.data.torrents[evidence.hash] = evidence.source.torrent.toString('base64');
            queue.updateItem(item, { selected: { ...item.selected, [evidence.hash]: {
              hash: evidence.hash, release: { ...ref, infoHash: evidence.hash }, source, numberingRevision: movie ? null : revision,
              matches: Object.fromEntries(candidates.map((entry) => [entry.id, manifest && matchedFile(manifest, point(entry))])),
              clientId: null, status: 'verify', manualMatches,
              ...('magnet' in source ? { manifest: evidence.files } : {}),
            } } });
          }
          reject('file_unmapped', movie ? candidates : candidates.filter((entry) =>
            ambiguous?.episodes.some((target) => target.season === entry.season && target.number === entry.number)));
          continue;
        }
        if (manifest && pack && !manifest.unknown.length && manifest.episodes.length) {
          const season = item.season!;
          const numbers = manifest.episodes.filter((target) => target.season === season).map(({ number }) => number).sort((a, b) => a - b);
          db.data.releaseCoverage[key] = { titleKey: title.key, season, numberingRevision: revision, numbers,
            files: Object.fromEntries(numbers.flatMap((number) => {
              const file = matchedFile(manifest, { season, number });
              return file ? [[number, file] as const] : [];
            })) };
        }
        const rejectPartial = () => {
          reject('pack_partial');
          Object.assign(work.checked[key]!, {
            lacks: candidates.filter((entry) => !prepared(item, entry.id) && !chosen.includes(entry)).map(({ id }) => id),
            matches: held((target) => manifest && matchedFile(manifest, target)),
          });
        };
        if (!chosen.length || (!pack && manifest && !evidenceTargets.some((entry) => chosen.includes(entry)))) {
          if (pack && partial?.missing.length) rejectPartial();
          else reject(pack ? 'metadata_unavailable' : 'wrong_episode');
          continue;
        }
        const verified = manifest ? decide(decision.release, want, ctx, { verified: manifest.episodes }) : decision;
        if (!verified.accepted) {
          record(verified);
          continue;
        }
        // A pack without every episode that still has no release is not a release for the season. Only the user can
        // choose it.
        if (pack && !payload.forced && !manualMatches && candidates.some((entry) => !prepared(item, entry.id) && !chosen.includes(entry))) {
          rejectPartial();
          continue;
        }
        record(verified);
        if (packScope !== undefined && !complete && work.packs[packScope]) continue;
        const selected = chosen.filter((entry) => (packScope !== undefined && complete) || !prepared(item, entry.id));
        if (!selected.length) continue;
        const source = 'torrent' in evidence.source ? { torrent: true as const } : evidence.source;
        const matches = Object.fromEntries(selected.map((entry) => [entry.id, movie?.file ?? (manifest && matchedFile(manifest, point(entry)))]));
        if (movieChoice && movie?.file) for (const entry of selected) {
          entry.manualMatch = { file: movie.file, covers: [] };
          entry.manualMatchRevision = db.data.queueRev + 1;
        }
        if (manualMatches) for (const entry of selected) {
          const file = matches[entry.id];
          const covers = file ? manualMatches[file] : undefined;
          if (file && covers) {
            entry.manualMatch = { file, covers };
            entry.manualMatchRevision = db.data.queueRev + 1;
          }
        }
        keep({
          hash: evidence.hash, release: { ...ref, infoHash: evidence.hash, ...(evidence.comment ? { comment: evidence.comment } : {}) },
          source, numberingRevision: manifest ? revision : null, matches, manualMatches,
          clientId: null, status: 'prepared', ...('magnet' in source ? { manifest: evidence.files } : {}),
        }, selected, verified, 'torrent' in evidence.source ? evidence.source.torrent : undefined);
        if (packScope !== undefined) work.packs[packScope] = evidence.hash;
        if (complete && packScope !== undefined) return;
      }
    };

    if (!missing().length) {
      sendPrepared(item);
      return;
    }
    if (payload.supplied) {
      const group = targets();
      const ranked = candidates(payload.supplied, group);
      await inspect(ranked.filter(({ decision }) => decision.kind === 'pack'), group, 'supplied');
      if (!holdingClient) await inspect(ranked.filter(({ decision }) => decision.kind !== 'pack'), group);
    }
    if (!holdingClient && !payload.forced && (title.mediaType === 'movie' || (targets().length > 1 && !episodeRound) || payload.otherSeasons)) {
      if (title.mediaType === 'movie' && !payload.supplied && missing().length) {
        const group = targets();
        const result = await ask({ kind: 'movie' }, group);
        if (!incomplete) await inspect(candidates(result, group), group);
      } else if (item.season !== null) {
        for (const season of releaseSeasons(numbering, item.season)) {
          const group = targets().filter((entry) => releaseTarget(numbering, entry)?.season === season);
          if (!group.some((entry) => !prepared(item, entry.id)) || !alive()) continue;
          const result = await ask({ kind: 'season', season }, group);
          if (incomplete) break;
          const ranked = candidates(result, group);
          await inspect(ranked.filter(({ decision }) => decision.kind === 'pack'), group, String(season));
          if (holdingClient) break;
          await inspect(ranked.filter(({ decision }) => decision.kind !== 'pack'), group);
          if (holdingClient) break;
        }
      }
    }
    const problems = () => {
      const ids = new Set(missing().map((entry) => entry.id));
      return Object.values({ ...Object.fromEntries(lacked), ...work.checked })
        .filter(({ decision, entries }) => !decision.accepted && entries.some((id) => ids.has(id)));
    };
    const mapping = () => problems().some(({ decision }) => decision.rejections.includes('file_unmapped'));
    const finished = (result?: string, entries: QueueEntry[] = []) => {
      if (result) {
        const profiles = profilesFor(ctx.quality, title).map(explainProfile);
        for (const entry of entries) {
          const decisions = Object.values(work.checked).filter(({ entries }) => entries.includes(entry.id)).map(({ decision }) => decision);
          const rejections = decisions.filter((decision) => !decision.accepted).sort(compareRejected);
          const candidates = rejections.slice(0, 8).map((decision) => explain(decision, entry));
          const count = `${rejections.length} ${rejections.length === 1 ? 'release' : 'releases'}`;
          const message = result === 'all_rejected' ? (rejections.length ? `No release selected: ${count}, all rejected` : 'No release selected')
            : result === 'no_results' ? 'No release found' : result === 'no_indexers' ? 'No release found: no indexer to ask'
              : result === 'indexers_failed' ? 'No release found: no indexer answered' : `No release selected: ${result}`;
          catalog.info('finished', message, itemFields(entry), {
            result, decisions: decisions.length, accepted: decisions.length - rejections.length, rejected: rejections.length,
            reasons: rejectionSummary(rejections), candidates, shown: candidates.length, profiles, run: work.id,
            nextSearchAt: searchState.nextAt === null ? null : new Date(searchState.nextAt).toISOString(),
          });
        }
      }
      if (title.mediaType === 'movie') return;
      const items = Object.values(db.data.queueItems).filter((other) => other.titleKey === title.key);
      if (items.some((other) => other.state.kind === 'queued' || other.state.kind === 'searching')) return;
      const active = items.flatMap((other) => other.entryIds.map(queue.get)).filter((entry): entry is QueueEntry => !!entry && isActive(entry));
      const accepted = members.filter((entry) => prepared(item, entry.id)).length;
      const waiting = active.filter((entry) => entry.state.kind === 'waiting').length;
      catalog.info('finished', `Series search finished: ${active.length} targets, ${accepted} accepted`, titleFields(title), {
        scope: 'series', targets: active.length, accepted, waiting, run: work.id,
      });
    };
    // True when a rejected pack does not hold a missing target that is past its release day.
    const refusedPack = () => {
      if (payload.forced || unavailable || noIndexers) return false;
      const lacks = new Set([...lacked.values(), ...Object.values(work.checked)].flatMap((checked) => checked.lacks ?? []));
      return missing().some((entry) => lacks.has(entry.id) && isOverdue(releaseDates.get(entry)!, searchState.at));
    };
    const completed: string[] = [];
    // A partial pack stops the season at once. The user then decides what to search.
    if (alive() && !incomplete && !holdingClient && !manualIds && title.mediaType !== 'movie' && !mapping() && !refusedPack()) {
      for (const entry of missing()) {
        if (!alive() || prepared(item, entry.id) || (!noIndexers && !dueFor.get(entry)!.length)) continue;
        const at = releaseTarget(numbering, entry);
        if (!at) continue;
        const group = [entry];
        const result = await ask({ kind: 'episode', season: at.season, number: at.number }, group);
        if (incomplete) break;
        await inspect(candidates(result, group), targets());
        if (holdingClient) break;
        if (title.seriesType === 'anime' && !numbering.ranges.length && !prepared(item, entry.id) && !result.length) {
          const absolute = await ask({ kind: 'absolute', number: absoluteNumber(title, entry.season!, entry.number!) }, group);
          if (incomplete) break;
          await inspect(candidates(absolute, group), targets());
          if (holdingClient) break;
        }
        completed.push(entry.id);
      }
    }
    if (!alive() || holdingClient) return;
    if (incomplete) {
      const nextAt = now() + SEARCH_CONTINUE_MS;
      Object.assign(searchState, { result: 'deferred', nextAt });
      queue.updateItem(item, { search: searchState });
      enqueueSearch(payload, { runAt: nextAt, afterRun: true });
      return;
    }
    const left = missing();
    // After a change of the season map, the episodes that the user did not choose stay stopped. The season cannot end
    // without them.
    const stopped = !payload.remapped ? [] : item.entryIds.map(queue.get).filter((entry): entry is QueueEntry =>
      entry?.state.kind === 'blocked' && ['queued', 'searching', 'fetching'].includes(entry.state.at) && !prepared(item, entry.id));
    if (!left.length && !stopped.length) {
      if (manualIds && !readySelection(item)) {
        const sibling = item.entryIds.flatMap((id) => {
          const entry = queue.get(id);
          return entry?.state.kind === 'blocked' && !manualIds.has(id) ? [entry.state] : [];
        })[0];
        if (sibling) queue.transitionItem(item, sibling);
        queue.updateItem(item, { candidate: null });
        return;
      }
      const pending = Object.values(item.selected).filter((source) => source.status === 'verify');
      const selected = Object.fromEntries(Object.entries(item.selected).filter(([, source]) => source.status !== 'verify'));
      Object.assign(searchState, { result: 'grabbed', accepted: Object.keys(selected).length, nextAt: null });
      phase('fetching', targets());
      queue.updateItem(item, { candidate: null, selected, search: searchState });
      for (const { hash } of pending) forgetUnusedSource(hash);
      sendPrepared(item);
      finished();
      return;
    }
    if (unavailable && !final && !payload.forced && left.length) throw new JobError('outage', 'An indexer did not answer.');
    const found = problems().sort((a, b) => compareRejected(a.decision, b.decision));
    const rejected = found.map(({ decision }) => decision);
    // Until the end of its release day a target can still lack its upload. An empty search or a pack without it does not stop it.
    const overdue = new Set(left.filter((entry) => isOverdue(releaseDates.get(entry)!, searchState.at)).map(({ id }) => id));
    const refused = found.some(({ decision }) => payload.forced || decision.rejections.some((code) => code !== 'pack_partial'));
    const missingNumber = title.mediaType !== 'movie' && left.some((entry) => !releaseTarget(numbering, entry));
    // A season pack that the search found and that does not hold a missing episode needs the user.
    const partialPack = !payload.forced && !unavailable && !noIndexers && overdue.size > 0 && (
      (!searchesPacks && earlierPacks.length > 0) ||
      found.some(({ decision, entries }) => decision.rejections.includes('pack_partial') && entries.some((id) => overdue.has(id))) ||
      Object.values(item.selected).some(({ status, release }) => status === 'prepared' && release.kind === 'pack'));
    const stop = mapping() ? 'file_unmapped' : missingNumber ? 'numbering_required' : partialPack ? 'pack_partial'
      : refused || (payload.forced && !completed.length) ? 'all_rejected'
        : noIndexers ? 'no_indexers' : payload.otherSeasons ? 'pack_partial'
          // A file that the user chose goes to the client when its season stops.
          : Object.values(item.selected).some(({ status, sendMapped }) => status === 'prepared' && sendMapped) ? 'file_unmapped'
            : stopped.length ? 'pack_partial' : null;
    const at = now();
    if (!stop) {
      for (const entry of left) {
        if (releaseToday) {
          entry.lastIndexerSearch ??= {};
          for (const indexer of dueFor.get(entry)!) entry.lastIndexerSearch[indexer.id] = at;
        } else delete entry.lastIndexerSearch;
      }
    }
    const nextAt = stop ? null : nextRetryAt(title, left, usable, at);
    Object.assign(searchState, {
      result: stop && rejected.length ? 'all_rejected' : unavailable ? 'indexers_failed' : 'no_results',
      candidates: Object.keys(work.checked).length, accepted: Object.values(item.selected).filter(({ status }) => status === 'prepared').length,
      nextAt, topRejections: topRejections(rejected),
      rejected: unique([...(stopped.length ? earlier : searchesPacks ? [] : earlierPacks), ...found.map(({ decision, matches }) =>
        ({ ...rejectionRow(decision), ...(matches && Object.keys(matches).length ? { matches } : {}) }))]),
    } satisfies Partial<SearchState>);
    // Every target of a stopped season stops in the same phase, so one retry takes all of them.
    const stopTargets = (cause: string) => {
      if (item.state.kind !== 'blocked') return;
      const { at: phase, problem } = item.state;
      const chosen = detach(db.data, item);
      for (const hash of chosen.hashes) forgetUnusedSource(hash);
      Object.assign(searchState, { rejected: unique([...searchState.rejected, ...chosen.rows]), nextAt: null,
        accepted: Object.values(item.selected).filter(({ status }) => status === 'prepared').length });
      for (const entry of new Set([...left, ...chosen.entries, ...stopped])) {
        const paused = entry.state.kind === 'paused';
        if (paused) queue.resume(entry, cause);
        queue.resolve(entry, phase, cause);
        queue.block(entry, problem, cause, problem.code);
        if (paused) queue.pause(entry, cause);
      }
      sendPrepared(item);
    };
    for (const entry of left) {
      forgetSource(entry);
      Object.assign(entry, { release: null, transferHash: null, clientId: null });
    }
    if (stop) {
      queue.transitionItem(item, { kind: 'blocked', at: item.state.kind === 'fetching' ? 'fetching' : 'searching', problem: { code: stop } });
      stopTargets('search ended');
      queue.updateItem(item, { search: searchState, candidate: stop === 'file_unmapped' ? Object.values(item.selected).find(({ status }) => status === 'verify')?.release ?? null : null });
      finished(stop, left);
      return;
    }
    const outcome = unavailable ? 'indexers_failed' : 'no_results';
    phase('searching', left);
    const emptyRounds = unavailable || !completed.length || !seasonHasCoverage(db.data, item) ? [] : left.filter((entry) => {
      if (!completed.includes(entry.id) || !overdue.has(entry.id)) return false;
      // A fast indexer cannot use up the episode's three rounds before a slower indexer answers.
      const answered = new Set(entry.emptyRoundIndexers);
      for (const indexer of dueFor.get(entry)!) answered.add(indexer.id);
      if (usable.every((indexer) => answered.has(indexer.id))) {
        delete entry.emptyRoundIndexers;
        return true;
      }
      entry.emptyRoundIndexers = [...answered];
      return false;
    });
    if (emptyRounds.length) queue.emptySearch(item, work.id, emptyRounds.map(({ id }) => id), nextAt);
    else queue.requeueItem(item, outcome, nextAt);
    if (item.state.kind === 'blocked') stopTargets('search attempts used');
    else for (const entry of left) queue.wait(entry, outcome, 'search ended', outcome);
    queue.updateItem(item, { search: searchState, candidate: null });
    if (item.state.kind === 'waiting' && nextAt !== null) enqueueSearch({ ...payload, work: undefined, supplied: undefined,
      fresh: false, forced: false, entryIds: left.map((entry) => entry.id), episodeRound: targets().some((entry) => prepared(item, entry.id)) }, { runAt: nextAt, afterRun: true });
    finished(outcome, left);
  }

  function canStartSearch(job: Job) {
    const payload = job.payload as Acquisition;
    const item = queue.findItem(payload.titleKey, payload.season);
    if (item?.state.kind === 'waiting' && item.nextAt !== null && item.nextAt > now()) return false;
    if (item && busyTransfer(item)) return false;
    return !payload.work?.magnet || !item?.clientHold || Boolean(clients.next());
  }

  async function search(payload: Acquisition, signal: AbortSignal, final = true, outside: OutsideTitleLock = (work) => work()) {
    try {
      await acquire(payload, signal, final, outside);
    } catch (error) {
      if (!(error instanceof StaleAcquisition)) throw error;
    }
  }

  // --- Upgrades ---------------------------------------------------------------------------

  // True while the target is still a target of the same upgrade search. The settings, the monitoring, and the file can
  // change while the indexers answer, so a caller asks again just before it takes a release.
  const stillUpgrade = (title: Title, season: number | null, number: number | null, quality: string) =>
    db.data.titles[title.key] === title && manualUpgradeTargets(title, quality).some((target) => target.season === season && target.number === number);

  // A file is a target for an upgrade search when no entry of it is in the journey.
  const upgradeFree = (target: { title: Title; season: number | null; number: number | null }) => {
    const entry = queue.get(entryId(target.title.key, target.season, target.number));
    return !entry || !isActive(entry);
  };

  // Looks for a release of the chosen quality for one file. It makes no queue entry until it finds a release to take.
  async function upgradeTarget(target: ReturnType<typeof manualUpgradeTargets>[number], quality: string, signal: AbortSignal) {
    const { title, season, number } = target;
    const numbering = numberingOf(title);
    const point = season === null ? null : releasePoint(numbering, { season, number: number! });
    if (season !== null && !point) return;
    const scope: Scope = season === null ? { kind: 'movie' } : { kind: 'episode', season: point!.season, number: point!.number };
    const want: Want = season === null ? { kind: 'movie', title, upgradeQuality: quality } : { kind: 'episode', title, season, number: number!, upgradeQuality: quality, numbering };
    for (const name of titleNames(title)) {
      const found = await queryAll(title, scope, name, [], signal, { fresh: true });
      if (!stillUpgrade(title, season, number, quality)) break;
      const best = bestOf(found.releases.map((release) => decide(release, want, decideContext())));
      if (best) {
        const entry = queue.ensure(title.key, season, number);
        if (queue.request(entry, 'upgrade search')) enqueueSearch({
          titleKey: title.key, season, entryIds: [entry.id], supplied: [best.release], upgrade: quality,
        });
      }
      // A name that returns releases is the name of the search. The aliases after it do not run.
      if (found.releases.length) break;
    }
  }

  // The files that a search of one quality covers: no indexer to ask, or a file in the journey, gives none.
  const upgradeFiles = (title: Title, quality: string) => (usableIndexers(title).length > 0 ? manualUpgradeTargets(title, quality).filter(upgradeFree) : []);

  // The user asks for an upgrade of a title to one quality. Each file below it is searched now.
  async function upgradeTitle(key: string, signal: AbortSignal, quality: string) {
    const title = db.data.titles[key];
    const targets = title ? upgradeFiles(title, quality) : [];
    for (const target of targets) {
      signal.throwIfAborted();
      await upgradeTarget(target, quality, signal);
    }
    return targets.length;
  }

  // --- RSS --------------------------------------------------------------------------------

  async function rss(signal: AbortSignal) {
    type Slot = { title: Title; wants: Want[] };
    // The library titles that have a target to fill, found by each of their names.
    const byName = new Map<string, Set<Slot>>();
    for (const title of Object.values(db.data.titles)) {
      if (title.paused) continue;
      const wants: Slot['wants'] = [];
      const numbering = numberingOf(title);
      if (title.mediaType === 'movie') {
        if (wantedMovie(title)) wants.push({ kind: 'movie', title });
      } else {
        const seasons = new Set<number>();
        for (const episode of title.episodes) {
          if (!wantedEpisode(title, episode)) continue;
          wants.push({ kind: 'episode', title, season: episode.season, number: episode.number, numbering });
          seasons.add(episode.season);
        }
        for (const season of seasons) for (const releaseSeason of releaseSeasons(numbering, season)) wants.push({ kind: 'season', title, season, releaseSeason, numbering });
      }
      if (!wants.length) continue;
      const slot: Slot = { title, wants };
      for (const name of [title.meta.title, title.meta.originalTitle, ...title.meta.aliases]) {
        const key = normalizeTitle(name);
        if (key) byName.set(key, (byName.get(key) ?? new Set()).add(slot));
      }
    }
    if (!byName.size) return;

    const ctx = decideContext();
    const offers = new Map<string, { title: Title; season: number | null; releases: Map<string, RawRelease> }>();
    for (const indexer of Object.values(db.data.indexers).filter((item) => item.push.sonarr?.enableRss || item.push.radarr?.enableRss)) {
      if (!indexers.usable(indexer)) continue;
      for (const appName of ['sonarr', 'radarr'] as const) {
        const push = indexer.push[appName];
        if (!push?.enableRss || notUsedReason(indexer, appName)) continue;
        let releases: RawRelease[];
        try {
          releases = await indexers.search(indexer, { kind: 'search', categories: [...push.categories, ...push.animeCategories], limit: 100 }, { signal });
        } catch (error) {
          if (signal.aborted) throw error;
          continue;
        }
        for (const release of releases) {
          // The name of the release starts with the title. This cheap test picks the titles to decide for, and decide() does the exact check.
          const name = normalizeTitle(release.title);
          const slots = new Set<Slot>();
          for (const [key, set] of byName) if (name.startsWith(key)) for (const slot of set) slots.add(slot);
          for (const slot of slots) {
            if (slot.title.mediaType !== (appName === 'radarr' ? 'movie' : 'tv')) continue;
            for (const want of slot.wants) {
              const decision = decide(release, want, ctx, { inspect: true });
              if (!decision.accepted) continue;
              const season = want.kind === 'movie' ? null : want.season;
              const key = `${want.title.key}:${season ?? ''}`;
              const offer = offers.get(key) ?? { title: want.title, season, releases: new Map() };
              offer.releases.set(releaseKey(release), release);
              offers.set(key, offer);
            }
          }
        }
      }
    }
    for (const { title, season, releases } of offers.values()) {
      const existing = queue.findItem(title.key, season);
      if (existing && !['waiting', 'queued'].includes(existing.state.kind)) continue;
      const wanted = title.mediaType === 'movie' ? [[null, null] as const] : title.episodes
        .filter((episode) => episode.season === season && wantedEpisode(title, episode)).map(({ season, number }) => [season, number] as const);
      const entries: QueueEntry[] = [];
      for (const [entrySeason, number] of wanted) {
        const target = queue.ensure(title.key, entrySeason, number);
        if (target.state.kind === 'cancelled') continue;
        if (target.state.kind === 'waiting' || target.state.kind === 'queued' && target.attempt || queue.request(target, 'found by RSS')) entries.push(target);
      }
      const item = queue.findItem(title.key, season);
      if (!entries.length || !item) continue;
      if (item.state.kind === 'waiting') queue.updateItem(item, { nextAt: now() });
      enqueueSearch({ titleKey: title.key, season, entryIds: entries.map(({ id }) => id), supplied: [...releases.values()] });
    }
  }

  // --- Sweep ------------------------------------------------------------------------------

  // A scan or a scheduled sweep gives no authorization to release a blocked target.
  function repairBlocked(_titleKey?: string) {}

  function sweep() {
    const t = now();
    const searches = Object.values(db.data.jobs).filter((job) => job.type === 'queue.search' && job.state !== 'failed');
    for (const item of Object.values(db.data.queueItems)) {
      const title = db.data.titles[item.titleKey];
      if (!title || title.paused || (item.clientHold && !clients.next())) continue;
      if (item.state.kind === 'fetching' || item.state.kind === 'downloading' ||
        (item.state.kind === 'blocked' && Object.values(item.selected).some((source) => source.sendMapped))) sendPrepared(item);
      if (!['queued', 'waiting', 'searching', 'fetching'].includes(item.state.kind)) continue;
      const entryIds = item.entryIds.filter((id) => {
        const entry = queue.get(id);
        return entry && eligibleEntry(entry) && !prepared(item, id);
      });
      if (!entryIds.length) continue;
      const held = searches.some((job) => {
        const payload = job.payload as Acquisition;
        return payload.titleKey === item.titleKey && payload.season === item.season;
      });
      if (held) continue;
      const supplied = item.candidate ? [rawOf(item.candidate)] : undefined;
      const otherSeasons = entryIds.some((id) => queue.get(id)?.attempts.at(-1)?.reason === OTHER_SEASONS_REASON);
      enqueueSearch({ titleKey: item.titleKey, season: item.season, entryIds, ...(supplied ? { supplied } : {}), ...(otherSeasons ? { otherSeasons } : {}) },
        { runAt: item.nextAt ?? t });
    }

    // Every target that is due and has no entry gets a search, however old the episode or the release is. A title
    // that was paused, or an app that was off, does not lose its old missing targets. A cancelled target stays out.
    for (const title of Object.values(db.data.titles)) {
      if (title.paused) continue;
      if (title.mediaType === 'movie') {
        if (wantedMovie(title) && !db.data.queue[title.key]) requestSearch(title.key, { reason: 'movie released' });
      } else {
        for (const episode of title.episodes) {
          if (!wantedEpisode(title, episode)) continue;
          const id = entryId(title.key, episode.season, episode.number);
          const entry = db.data.queue[id];
          if (entry?.state.kind === 'cancelled') continue;
          if (!entry) requestSearch(title.key, { season: episode.season, number: episode.number, reason: 'episode aired' });
        }
      }
    }
  }

  // --- Interactive search -----------------------------------------------------------------

  function seasonItem(anchor: QueueEntry) {
    const current = queue.itemFor(anchor);
    if (current) return current;
    const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === anchor.titleKey &&
      entry.season === anchor.season && entry.attempt > 0 && !entry.clearedAt);
    const searches = entries.flatMap(({ search }) => search ?? []).sort((a, b) => b.at - a.at);
    const item = newTurn(anchor.titleKey, anchor.season, db.data.queueItemSeq++, Math.min(...entries.map(({ createdAt }) => createdAt)));
    item.entryIds = entries.map(({ id }) => id);
    const priorities = entries.flatMap(({ priority }) => priority ?? []);
    if (priorities.length) item.priority = Math.min(...priorities);
    const blocked = entries.find(({ state }) => state.kind === 'blocked');
    if (blocked) {
      item.state = structuredClone(blocked.state);
      item.stateSince = blocked.stateSince;
    }
    if (searches[0]) {
      const rejected = new Map<string, RejectedRelease>();
      for (const search of searches) for (const release of search.rejected) {
        if (!rejected.has(releaseKey(release))) rejected.set(releaseKey(release), release);
      }
      item.search = { ...searches[0], rejected: [...rejected.values()] };
    }
    db.data.queueItems[item.id] = item;
    return item;
  }

  // The caller checks the whole batch under the title lock before it applies any assignment.
  function applyRejectedMapping(anchor: QueueEntry, batch: RejectedMapping[]): void {
    const item = seasonItem(anchor);
    const title = db.data.titles[anchor.titleKey]!;
    const numbering = numberingOf(title);
    const ids = new Set(batch.flatMap(({ files }) => files.flatMap(({ ids }) => ids)));
    const selected = { ...item.selected };
    const removed: string[] = [];
    for (const source of Object.values(selected)) {
      if (!['verify', 'prepared'].includes(source.status) || source.sendMapped) continue;
      if (!Object.keys(source.matches).some((id) => ids.has(id))) continue;
      const matches = Object.fromEntries(Object.entries(source.matches).filter(([id]) => !ids.has(id)));
      if (Object.keys(matches).length) selected[source.hash] = { ...source, matches };
      else {
        delete selected[source.hash];
        removed.push(source.hash);
      }
    }

    const mapped: QueueTorrent[] = [];
    const cause = 'file selected by the user';
    for (const { candidate, evidence, files } of batch) {
      const { hash } = evidence;
      const source = 'torrent' in evidence.source ? { torrent: true as const } : evidence.source;
      const torrent: QueueTorrent = {
        hash, release: refFor(title, { release: candidate, kind: candidate.kind, hash }, true),
        source, numberingRevision: numbering.revision, status: 'prepared', clientId: null, matches: {}, sendMapped: true,
        ...('magnet' in source ? { manifest: evidence.files } : {}),
      };
      if (evidence.comment) torrent.release.comment = evidence.comment;
      if ('torrent' in evidence.source) db.data.torrents[hash] = evidence.source.torrent.toString('base64');
      selected[hash] = torrent;
      mapped.push(torrent);
      for (const { file, ids } of files) {
        const targets = ids.map((id) => queue.get(id)!);
        const covers = targets.map(({ season, number }) => ({ season: season!, number: number! }));
        (torrent.manualMatches ??= {})[file] = covers;
        for (const entry of targets) {
          queue.retryAttempt(entry, cause);
          torrent.matches[entry.id] = file;
          Object.assign(entry, {
            release: torrent.release, transferHash: hash, clientId: null,
            source: torrent.source, numbering, manualMatch: { file, covers }, manualMatchRevision: db.data.queueRev + 1,
            importTries: 0, importResult: null, partialPack: null, replaceDestination: undefined,
          });
          entry.attempts.at(-1)!.release = torrent.release.title;
          queue.resolve(entry, 'fetching', cause, file);
        }
      }
    }
    const candidate = Object.values(selected).find((source) => source.status === 'verify')?.release ?? null;
    queue.updateItem(item, { selected, candidate });
    for (const hash of removed) forgetUnusedSource(hash);

    const pending = item.entryIds.some((id) => {
      const entry = queue.get(id);
      if (!entry || !isActive(entry) || ['downloading', 'importing'].includes(entry.state.kind)) return false;
      return !entry.transferHash || !selected[entry.transferHash]?.sendMapped || !sendPhase(entry);
    });
    // A search that still takes another episode goes on. It stops the season if it must.
    const searching = ['queued', 'searching', 'fetching'].includes(item.state.kind) && item.entryIds.some((id) => {
      const entry = queue.get(id);
      return entry && !entry.transferHash && ['queued', 'searching', 'fetching'].includes(entry.state.kind);
    });
    if (searching) return enqueueSelection(item, enqueue, mapped);
    if (pending) {
      if (item.state.kind !== 'blocked') queue.transitionItem(item, { kind: 'blocked', at: 'fetching', problem: { code: 'file_unmapped' } });
    } else if (!['downloading', 'importing'].includes(item.state.kind)) {
      if (['queued', 'waiting'].includes(item.state.kind)) queue.transitionItem(item, { kind: 'searching' });
      queue.transitionItem(item, { kind: 'fetching' });
    }
    enqueueSelection(item, enqueue, mapped);
  }

  // The target that a release names. A pack covers its release season, an episode covers itself, and a release that
  // does not say which episode it has falls back to the target that the user opened. The numbers of the release go to
  // the catalog through the saved numbering.
  function wantForRelease(title: Title, release: RawRelease, season?: number, number?: number): Want | undefined {
    if (title.mediaType === 'movie') return { kind: 'movie', title };
    const numbering = numberingOf(title);
    const parsed = parseRelease(release.title);
    if (parsed.multiSeason && season !== undefined) return number === undefined
      ? { kind: 'season', title, season, numbering }
      : { kind: 'episode', title, season, number, numbering };
    if (parsed.pack && parsed.season !== null) {
      const seasons = catalogSeasons(numbering, parsed.season);
      const catalog = season !== undefined && seasons.includes(season) ? season : seasons[0]!;
      return { kind: 'season', title, season: catalog, releaseSeason: parsed.season, numbering };
    }
    const first = parsed.episodes[0];
    if (parsed.season !== null && first !== undefined) {
      const point = catalogPoint(numbering, { season: parsed.season, number: first });
      // The release names an episode that the map gives to no catalog episode. It is not a release of this title.
      return point ? { kind: 'episode', title, season: point.season, number: point.number, numbering } : undefined;
    }
    return number !== undefined && season !== undefined ? { kind: 'episode', title, season, number, numbering } : undefined;
  }

  function pendingPackEntries(want: Extract<Want, { kind: 'season' }>) {
    const { title, season, releaseSeason } = want;
    const item = queue.findItem(title.key, season);
    if (item && item.state.kind !== 'blocked') return [];
    const numbering = numberingOf(title);
    return title.episodes.flatMap((episode) => {
      if (episode.season !== season || episode.removedFromTmdb || !wantedEpisode(title, episode)) return [];
      if (releaseSeason !== undefined && releasePoint(numbering, episode)?.season !== releaseSeason) return [];
      const entry = queue.get(entryId(title.key, season, episode.number));
      if (!entry || entry.clearedAt || entry.clientId || entry.transferHash || entry.release?.uploadPath) return [];
      if (item ? !item.entryIds.includes(entry.id) || prepared(item, entry.id) : !entry.attempt) return [];
      const { state } = entry;
      const pending = state.kind === 'blocked' ? ['queued', 'searching', 'fetching'].includes(state.at)
        : !entry.release && ['queued', 'waiting', 'searching'].includes(state.kind);
      return pending ? [entry] : [];
    });
  }

  // Grabs a release that the user chose. A person can take any release by hand, also one that the automatic search
  // rejected.
  function grabManual(entries: QueueEntry[], release: RawRelease, want: Want) {
    const hard = ['invalid_torrent', 'invalid_magnet', 'no_download_link', 'no_video'].filter((code) => entries.some((entry) =>
      entry.search?.rejected.some((row) => releaseKey(row) === releaseKey(release) && row.reasons.includes(REJECTION_TEXT[code]!))));
    if (hard.length) return { rejections: hard };
    const decision = decide(release, want, decideContext(true));
    if (!decision.accepted) return { rejections: decision.rejections };
    if (!entries.length || entries.some((entry) =>
      entry.titleKey !== want.title.key ||
      !['blocked', 'waiting', 'queued', 'searching', 'available', 'cancelled'].includes(entry.state.kind) ||
      (['queued', 'searching', 'waiting'].includes(entry.state.kind) && entry.release !== null),
    )) return { rejections: ['already_downloading'] };
    if (entries.some((entry) => entry.season !== entries[0]!.season)) return { rejections: ['wrong_season'] };
    const title = db.data.titles[want.title.key];
    if (!title || (title.mediaType !== 'movie' && decision.numbering && numberingOf(title).revision !== decision.numbering.revision)) return { rejections: ['wrong_episode'] };
    if (want.kind === 'season') seasonItem(entries[0]!);
    for (const entry of entries) {
      if (entry.state.kind === 'blocked') {
        queue.retryAttempt(entry, 'release chosen by the user');
        if (entry.release?.uploadPath) forgetSource(entry);
        Object.assign(entry, { release: null, transferHash: null, clientId: null, source: null, manualMatch: null, importResult: null });
        queue.resolve(entry, 'queued', 'release chosen by the user');
      } else if (entry.state.kind === 'waiting') queue.enter(entry, 'queued', 'release chosen by the user');
      else queue.request(entry, 'release chosen by the user');
    }
    const item = queue.itemFor(entries[0]!);
    if (!item || entries.some((entry) => queue.itemFor(entry) !== item)) return { rejections: ['wrong_season'] };
    if (item.state.kind === 'blocked') queue.transitionItem(item, { kind: 'fetching' });
    else {
      queue.transitionItem(item, { kind: 'searching' });
      queue.transitionItem(item, { kind: 'fetching' });
    }
    const candidate = refFor(title, decision, true);
    for (const entry of entries) {
      entry.release = candidate;
      queue.enter(entry, 'fetching', 'release chosen by the user');
    }
    queue.updateItem(item, { candidate });
    enqueueSearch({ titleKey: title.key, season: item.season, entryIds: entries.map(({ id }) => id), manual: true, forced: true, supplied: [release] });
    return { reserved: true };
  }

  // The episodes that the pack lacks, in the log line that records it. The reason alone does not say which one was missing.
  // Each lacking target writes this line, so the list holds the first episodes only: a full list makes the log grow with the square of the pack.
  const MAX_LISTED = 20;
  const packDetail = (missing: QueueEntry[], files: number) => ({ files, missingCount: missing.length, missing: missing.slice(0, MAX_LISTED).map((entry) => `${entry.season}x${entry.number}`) });

  // Known file coverage keeps an unsuitable pack out of later searches. Unknown coverage does not establish absence.
  function partial(entries: QueueEntry[], missing: QueueEntry[], { files, releaseSeason, numbers }: { files: number; releaseSeason?: number | null; numbers?: number[] }) {
    if (!numbers?.length) {
      for (const entry of missing) {
        if (entry.state.kind === 'blocked' || entry.state.kind === 'paused' || !isActive(entry)) continue;
        queue.endAttempt(entry, 'failed', 'file_unmapped');
        queue.block(entry, { code: 'file_unmapped' }, 'file coverage is unknown');
      }
      return entries.filter((entry) => !missing.includes(entry));
    }
    const leader = entries[0];
    const ref = leader?.release ?? null;
    const season = missing[0]?.season ?? null;
    if (leader && ref && season !== null) {
      const revision = normalizeNumbering(leader.numbering ?? db.data.titles[leader.titleKey]?.numbering).revision;
      const key = `${ref.indexerId}:${ref.guid}`;
      const previous = db.data.releaseCoverage[key];
      // An acquisition of an older map does not replace the coverage that a newer map read.
      if (!previous || previous.numberingRevision <= revision) {
        db.data.releaseCoverage[key] = {
          titleKey: leader.titleKey,
          season,
          numbers: releaseSeason === null || releaseSeason === undefined
            ? entries.filter((entry) => !missing.includes(entry) && entry.season === season).map((entry) => entry.number!)
            : numbers.flatMap((number) => {
                const point = catalogPoint(normalizeNumbering(leader.numbering ?? db.data.titles[leader.titleKey]?.numbering), { season: releaseSeason, number });
                return point?.season === season && db.data.titles[leader.titleKey]?.episodes.some((episode) => episode.season === point.season && episode.number === point.number) ? [point.number] : [];
              }),
          numberingRevision: revision,
        };
      }
    }
    const detail = packDetail(missing, files);
    for (const entry of missing) {
      if (entry.state.kind === 'blocked' || entry.state.kind === 'paused' || !isActive(entry)) continue;
      catalog.warn('release_failed', `${entry.release ? `"${entry.release.title}"` : 'The release'} failed: pack_partial`, itemFields(entry), { code: 'pack_partial', release: entry.release?.title ?? null, ...detail });
      queue.endAttempt(entry, 'failed', 'pack_partial');
      // The files of the pack say which season of the releases it is, so the manual search starts from that season.
      if (releaseSeason !== undefined) entry.partialPack = { releaseSeason, numbers: numbers ?? [] };
      queue.block(entry, { code: 'pack_partial' }, 'pack does not hold every episode', 'pack_partial');
    }
    return entries.filter((entry) => !missing.includes(entry));
  }

  // The manual search of the other seasons of the releases, for the targets of one season that a pack left without a
  // file. It checks the targets again, so two requests at the same time start one search.
  function startOtherSeasons(entries: QueueEntry[]) {
    const bySeason = new Map<string, QueueEntry[]>();
    for (const entry of entries) {
      if (!needsOtherSeasons(entry.state)) continue;
      queue.retryAttempt(entry, OTHER_SEASONS_REASON);
      Object.assign(entry, { release: null, transferHash: null, clientId: null, source: null, manualMatch: null, importResult: null, importTries: 0, numbering: normalizeNumbering(db.data.titles[entry.titleKey]?.numbering) });
      queue.resolve(entry, 'queued', OTHER_SEASONS_REASON);
      const key = `${entry.titleKey}|${entry.season ?? ''}`;
      bySeason.set(key, [...(bySeason.get(key) ?? []), entry]);
    }
    for (const group of bySeason.values()) {
      const first = group[0]!;
      const item = queue.itemFor(first);
      if (item?.state.kind === 'blocked') queue.transitionItem(item, { kind: 'queued' });
      enqueueSearch({ titleKey: first.titleKey, season: first.season, entryIds: group.map((entry) => entry.id), fresh: true, otherSeasons: true });
    }
    return [...bySeason.values()].flat();
  }

  return { requestSearch, restartSearch, partial, startOtherSeasons, enqueueSearch, grabManual, pendingPackEntries, applyRejectedMapping, wantForRelease, decideContext, usableIndexers, queryAll, wantedEpisode, wantedMovie, repairBlocked, rescheduleReleaseDay, sweep, rss, search, canStartSearch, upgradeTitle, upgradeCount: (title: Title, quality: string) => upgradeFiles(title, quality).length, clearCache: () => cache.clear() };
}
