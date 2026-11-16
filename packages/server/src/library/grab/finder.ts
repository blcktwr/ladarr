import { type Db, db, profilesFor } from '../../core/db.ts';
import { randomUUID } from 'node:crypto';
import { languageOfRegion } from '../../core/languages.ts';
import { episodeEligibleAt } from '../../core/dates.ts';
import { absoluteNumber, bestOf, decide, explainDecision, REJECTION_TEXT, rejectionSummary, topRejections, type Context, type Decision, type Want } from './decide.ts';
import { indexerName, indexersFor, notUsedReason, seedLimits, type Indexer, type IndexerApp } from './indexers.ts';
import { explainProfile } from './quality.ts';
import { enqueue as enqueueJob, JobError, prioritize, type EnqueueInput, type Job } from '../../core/jobs.ts';
import { isMonitored, movieEligibleAt, type Episode, type Title } from '../library.ts';
import { catalog, itemFields, titleFields } from '../../core/log.ts';
import { entryId, isActive, phaseOfEntry, type Queue, type QueueEntry, type ReleaseRef, type SearchState } from '../downloads/queue.ts';
import { createClients, type Clients } from '../downloads/client-api.ts';
import { importLocal } from '../imports/local.ts';
import type { Continuation } from '../parse.ts';
import { normalizeTitle, parseRelease } from './release.ts';
import type { IndexerService, RawRelease, SearchQuery } from './torznab.ts';
import { manualUpgradeTargets } from './upgrades.ts';
import { requestIdFor } from '../../core/outbound.ts';
import { needsOtherSeasons } from '@ladarr/shared/queue';

// The reason of the attempt that the manual search of the other seasons of the releases starts. A target that a lost
// job leaves behind continues in that mode, not in a normal search.
export const OTHER_SEASONS_REASON = 'search other seasons';

// How long a waiting entry waits before the next search. The RSS sync finds new releases in between.
export const RESEARCH_MS = 12 * 60 * 60_000;
// A title that waits for its release is searched again when that date comes, not after a few hours.
const nextSearchAt = (title: Title, at: number) => {
  if (title.mediaType !== 'movie' || title.manualRelease) return at + RESEARCH_MS;
  const release = movieEligibleAt(title);
  return release !== null && release > at ? release : at + RESEARCH_MS;
};
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 200;
const DAY_MS = 24 * 60 * 60_000;
// The most search requests that one automatic search run sends for one title. A run that reaches the budget leaves
// the rest of its work for the next run.
const SEARCH_BUDGET = 12;
// The wait before the next run of a search that the budget stopped. The cache of the first queries is still valid,
// so the next run continues from them without a new request.
const SEARCH_CONTINUE_MS = 1_000;

export type Scope = { kind: 'movie' } | { kind: 'season'; season: number } | { kind: 'episode'; season: number; number: number } | { kind: 'absolute'; number: number };
type TitleName = { value: string; alias: boolean; languages: string[] };
// The work that a search run left for the next run after it reached its budget. The phase and the target say where
// the next run continues: the season queries run again from the cache, and the individual queries start at this target.
export type SearchResume = { phase: 'episode' | 'absolute'; entryId: string };
// `fresh` skips the cache of raw results. A search that the user asks for is fresh. `manual` marks a target that the
// user selected, so its individual query runs whatever the age of the episode. `otherSeasons` marks the manual search
// of the other seasons of the releases: it has its own jobs and it never merges with a normal search.
export type SearchPayload = { titleKey: string; season: number | null; entryIds: string[]; fresh?: boolean; manual?: boolean; otherSeasons?: boolean; resume?: SearchResume };

type Deps = {
  queue: Queue;
  indexers: IndexerService;
  enqueue: (input: EnqueueInput) => Job;
  // The download client, so a torrent that already holds the files of a folder stays with the target.
  clients?: Clients;
  now?: () => number;
};

const present = (fileId: string | null) => Boolean(fileId && db.data.files[fileId] && !db.data.files[fileId]!.missing);
// Ties the log line of a search to the requests that answered it, in the app log and in the request log.
const newRequestId = () => `req-${randomUUID().replaceAll('-', '').slice(0, 12)}`;

export function createFinder({ queue, indexers, enqueue, clients = createClients(), now = Date.now }: Deps) {
  const cache = new Map<string, { at: number; releases: RawRelease[] }>();
  // Equal queries that run at the same time share one request.
  const inflight = new Map<string, { requestId: string; releases: Promise<RawRelease[]> }>();
  // An episode counts as recent for a week after its air date. A recent episode keeps its individual search, and
  // the sweep starts a search for it.
  const recentAirMs = 7 * DAY_MS;

  // --- What ladarr wants -------------------------------------------------------------------

  const aired = (episode: Episode) => {
    const at = episodeEligibleAt(episode.airDate);
    return at !== null && at <= now();
  };

  const wantedEpisode = (title: Title, episode: Episode) => !title.paused && isMonitored(title, episode) && aired(episode) && !present(episode.fileId);

  function wantedMovie(title: Title) {
    if (title.paused || present(title.fileId)) return false;
    const at = movieEligibleAt(title);
    return title.manualRelease || (at !== null && at <= now());
  }

  function decideContext(manual = false): Context {
    const hashes = new Set<string>();
    for (const entry of Object.values(db.data.queue)) if (entry.transferHash && isActive(entry) && phaseOfEntry(entry) !== 'queued') hashes.add(entry.transferHash);
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
  function enqueueSearch(payload: SearchPayload, { runAt = Date.now(), afterRun = false }: { runAt?: number; afterRun?: boolean } = {}): Job {
    const modeOf = (other: SearchPayload) => `${Boolean(other.otherSeasons)}|${Boolean(other.manual)}`;
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
      const current = primary.payload as SearchPayload;
      const ids = new Set<string>();
      for (const item of [current, ...duplicates.map((job) => job.payload as SearchPayload), payload]) for (const id of item.entryIds) ids.add(id);
      const entryIds = [...ids];
      const fresh = Boolean(current.fresh || payload.fresh || duplicates.some((job) => (job.payload as SearchPayload).fresh));
      const manual = Boolean(current.manual || payload.manual || duplicates.some((job) => (job.payload as SearchPayload).manual));
      const otherSeasons = Boolean(current.otherSeasons || payload.otherSeasons || duplicates.some((job) => (job.payload as SearchPayload).otherSeasons));
      // A continuation is valid only for the same targets. A new target starts the search from the first phase.
      const sameTargets = current.entryIds.length === ids.size && current.entryIds.every((id) => ids.has(id));
      const resume = sameTargets ? (payload.resume ?? current.resume) : undefined;
      const merged: SearchPayload = { ...payload, entryIds, ...(resume ? { resume } : {}), ...(manual ? { manual: true } : {}) };
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

  // Puts the targets in the queue and starts their search. A target that is in the journey already is left as it is.
  // `only` takes the targets of that set, so a search that the sweep starts does not touch a target that is not due.
  // Returns the entries that the request started.
  function requestSearch(titleKey: string, { season, number, reason = 'search requested', fresh = false, manual = false, only }: { season?: number; number?: number; reason?: string; fresh?: boolean; manual?: boolean; only?: ReadonlySet<string> } = {}): QueueEntry[] {
    const title = db.data.titles[titleKey];
    if (!title) return [];
    const started: QueueEntry[] = [];
    const bySeason = new Map<number, QueueEntry[]>();

    // Opens the target for this search, and makes its entry when it has none. It returns undefined when the target is not due.
    const open = (targetSeason: number | null, targetNumber: number | null): QueueEntry | undefined => {
      if (only && !only.has(entryId(titleKey, targetSeason, targetNumber))) return undefined;
      const entry = queue.ensure(titleKey, targetSeason, targetNumber);
      // An entry that waits for a release searches again now. Any other active entry already has work.
      if (entry.state.kind === 'waiting') {
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
      for (const [seasonNumber, entries] of bySeason) enqueueSearch({ titleKey, season: seasonNumber, entryIds: entries.map((e) => e.id), fresh, ...(manual ? { manual } : {}) });
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
  function usableIndexers(title: Title, interactive = false) {
    return indexersFor(title.mediaType).filter((indexer) => {
      const push = indexer.push[app(title)]!;
      return !notUsedReason(indexer, app(title)) && (interactive ? push.enableInteractiveSearch : push.enableAutomaticSearch);
    });
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
  async function queryAll(title: Title, scope: Scope, name: TitleName, entries: QueueEntry[], signal: AbortSignal, { forUser = false, fresh = false, quiet = false, budget }: { forUser?: boolean; fresh?: boolean; quiet?: boolean; budget?: { left: number } } = {}) {
    const usable = usableIndexers(title, forUser);
    // An indexer with preferred languages receives only an alias in one of them. No languages means every name.
    const list = usable.filter((indexer) => {
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
    const report = (patch: (search: SearchState) => void) => {
      for (const entry of entries) {
        entry.search ??= structuredClone(state);
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
          }
          const query = queryFor(indexer, title, scope, name.value);
          const key = JSON.stringify([indexer.id, query]);
          const hit = cache.get(key);
          let cached = false;
          if (hit && !fresh && now() - hit.at < CACHE_MS) {
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
            cache.set(key, { at: now(), releases: found });
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

  const fileOf = (title: Title, entry: QueueEntry) => (title.mediaType === 'movie' ? title.fileId : (title.episodes.find((e) => e.season === entry.season && e.number === entry.number)?.fileId ?? null));

  function wantFor(title: Title, entry: QueueEntry): Want {
    return title.mediaType === 'movie' ? { kind: 'movie', title } : { kind: 'episode', title, season: entry.season!, number: entry.number! };
  }

  const RESULT_MESSAGE: Record<string, string> = {
    no_indexers: 'No release found: no indexer to ask',
    indexers_failed: 'No release found: no indexer answered',
    all_rejected: 'No release selected: every release was rejected',
    no_results: 'No release found',
  };
  const MAX_CANDIDATES = 8;

  function noResult(entries: QueueEntry[], title: Title, decisionsOf: (entry: QueueEntry) => Decision[], asked: number, answered: number, found: number, profiles: ReturnType<typeof profilesFor>, { partial = false }: { partial?: boolean } = {}) {
    const shownProfiles = profiles.map(explainProfile);
    for (const entry of entries) {
      // One release can come from more than one query, as a pack and as a single episode. The closest decision of the
      // release stays, so the reasons and the counts do not repeat it.
      const closest = new Map<string, Decision>();
      for (const decision of decisionsOf(entry)) {
        const key = `${decision.release.indexerId}:${decision.release.guid}`;
        const current = closest.get(key);
        if (!current || decision.rejections.length < current.rejections.length) closest.set(key, decision);
      }
      const decisions = [...closest.values()];
      const code = asked === 0 ? 'no_indexers' : answered === 0 ? 'indexers_failed' : decisions.length ? 'all_rejected' : 'no_results';
      const rejections = topRejections(decisions);
      // An upgrade that finds nothing is not a missing title. The file stays, and the target is available.
      if (present(fileOf(title, entry))) {
        catalog.info('finished', 'No better release: the current file stays', itemFields(entry), { result: 'no_better_release', profiles: shownProfiles });
        queue.endAttempt(entry, 'failed', 'no_better_release');
        queue.complete(entry, 'no better release');
        continue;
      }
      // Every release that the search found and rejected. A person can take any of them by hand, so the list keeps the
      // reason that stopped each one and offers the button that grabs it.
      const rejected = decisions
        .filter((decision) => !decision.accepted)
        .sort((a, b) => a.rejections.length - b.rejections.length || (b.release.seeders ?? 0) - (a.release.seeders ?? 0))
        .slice(0, MAX_CANDIDATES)
        .map((decision) => {
          const sizeCode = decision.rejections.find((code) => code === 'size_below_min' || code === 'size_above_max');
          const sizeLimit = sizeCode === 'size_above_max' ? decision.limits?.max : decision.limits?.min;
          return {
            indexerId: decision.release.indexerId,
            guid: decision.release.guid,
            title: decision.release.title,
            link: decision.release.link,
            magnet: decision.release.magnet,
            infoHash: decision.hash,
            sizeBytes: decision.release.sizeBytes,
            seeders: decision.release.seeders,
            resolution: decision.parsed.resolution,
            source: decision.parsed.source,
            kind: decision.kind,
            reasons: decision.rejections.map((code) => REJECTION_TEXT[code] ?? code),
            sizeRejection: sizeCode && sizeLimit != null && decision.mibPerMinute !== null ? { code: sizeCode, value: decision.mibPerMinute, limit: sizeLimit } : null,
          };
        });
      Object.assign(entry.search!, { result: code === 'no_indexers' ? 'no_results' : code, accepted: 0, candidates: decisions.length, topRejections: rejections, nextAt: nextSearchAt(title, now()), rejected });
      // The releases that came closest to acceptance first: the fewest reasons, then the most seeders. A person sees
      // what the indexers offered and which rule stopped each one.
      const explained = decisions.map((decision) =>
        explainDecision(decision, {
          profiles,
          indexer: db.data.indexers[decision.release.indexerId]?.push[title.mediaType === 'movie' ? 'radarr' : 'sonarr']?.name ?? 'Indexer',
          year: title.meta.year,
          season: entry.season,
          number: entry.number,
          audioLanguage: db.data.settings.audio?.language ?? null,
        }),
      );
      const candidates = explained
        .filter((item) => !item.accepted)
        .sort((a, b) => a.reasons.length - b.reasons.length || (b.seeders ?? 0) - (a.seeders ?? 0))
        .slice(0, MAX_CANDIDATES);
      const summary = rejectionSummary(decisions);
      const count = `${decisions.length} ${decisions.length === 1 ? 'release' : 'releases'}`;
      const message = code === 'all_rejected' ? `No release selected: ${count}, all rejected` : (RESULT_MESSAGE[code] ?? `No release found: ${code}`);
      catalog.info('finished', message, itemFields(entry), {
        result: code,
        asked,
        answered,
        found,
        decisions: decisions.length,
        accepted: decisions.filter((decision) => decision.accepted).length,
        rejected: decisions.filter((decision) => !decision.accepted).length,
        reasons: summary,
        candidates,
        shown: candidates.length,
        profiles: shownProfiles,
        nextSearchAt: entry.search?.nextAt ? new Date(entry.search.nextAt).toISOString() : null,
      });
      // The manual search of the other seasons of the releases ends with its targets where the pack left them: the
      // user starts it again when a release of another season appears.
      if (partial) {
        Object.assign(entry.search!, { nextAt: null });
        queue.block(entry, { code: 'pack_partial' }, 'other seasons ended', 'pack_partial');
      }
      // A target that cannot search now keeps its problem, so the sweep does not start it again at once.
      else if (code === 'no_indexers') queue.block(entry, { code: 'no_indexers' }, 'search ended');
      else queue.wait(entry, code === 'no_results' || code === 'all_rejected' ? code : code === 'indexers_failed' ? 'indexers_failed' : 'unspecified', 'search ended', code);
    }
  }

  // The reservation. It checks and changes in one step, so two searches cannot both take a target.
  function reserve(entries: QueueEntry[], decision: Decision, manual = false): boolean {
    if (entries.some((entry) => entry.release || !['queued', 'searching'].includes(entry.state.kind) || entry.state.kind === 'cancelled' || entry.state.kind === 'paused')) return false;
    const { release } = decision;
    const indexer = db.data.indexers[release.indexerId];
    const title = db.data.titles[entries[0]!.titleKey];
    const ref: ReleaseRef = {
      guid: release.guid,
      indexerId: release.indexerId,
      indexerName: db.data.indexers[release.indexerId]?.push.sonarr?.name ?? db.data.indexers[release.indexerId]?.push.radarr?.name ?? 'Indexer',
      title: release.title,
      sizeBytes: release.sizeBytes,
      infoHash: decision.hash,
      link: release.link,
      magnet: release.magnet,
      kind: decision.kind,
      seeders: release.seeders,
      manual,
      seed: indexer && title ? seedLimits(indexer, app(title), decision.kind === 'pack') : null,
    };
    const profiles = title ? profilesFor(db.data, title) : [];
    const explained = title
      ? explainDecision(decision, { profiles, indexer: ref.indexerName, year: title.meta.year, season: entries[0]!.season, number: entries[0]!.number, audioLanguage: db.data.settings.audio?.language ?? null })
      : null;
    for (const entry of entries) {
      entry.release = ref;
      entry.transferHash = decision.hash;
      entry.search && Object.assign(entry.search, { result: 'grabbed', accepted: 1 });
      const attempt = entry.attempts.at(-1);
      if (attempt) attempt.release = release.title;
      catalog.info('release_chosen', `Chose "${release.title}" from ${ref.indexerName}`, itemFields(entry), {
        ...explained,
        kind: ref.kind,
        manual,
        infoHash: decision.hash,
        covers: entries.map((item) => item.id),
        profiles: profiles.map(explainProfile),
      });
      queue.enter(entry, 'fetching', 'release selected', release.title);
    }
    // The worker starts the downloads in the order of the queue, so the first target of the list takes a free slot first.
    // A title keeps the position of its first target, as its row does.
    const titleEntries = Object.values(db.data.queue).filter((item) => item.titleKey === entries[0]!.titleKey && item.attempt > 0 && !item.clearedAt);
    const runAt = Math.min(entries[0]!.createdAt, ...titleEntries.map((item) => item.createdAt));
    enqueue({ type: 'queue.grab', payload: { entryIds: entries.map((e) => e.id) }, dedupeKey: `grab:${entries[0]!.id}`, runAt, priority: entries.some((e) => e.priority !== null) });
    return true;
  }

  async function search(payload: SearchPayload, signal: AbortSignal, final = true) {
    const title = db.data.titles[payload.titleKey];
    if (!title || title.paused) return;
    // A search job can run for targets that wait for their next search, so the job itself opens those targets.
    const entries = payload.entryIds
      .map((id) => queue.get(id))
      .filter((entry): entry is QueueEntry => Boolean(entry) && isActive(entry) && (entry!.state.kind === 'waiting' || entry!.state.kind === 'queued' || entry!.state.kind === 'searching'));
    if (!entries.length) return;
    for (const entry of entries) if (entry.state.kind === 'waiting') queue.enter(entry, 'queued', 'search again');
    const startedAt = now();
    const ctx = decideContext();
    const profiles = profilesFor(ctx.quality, title);
    for (const entry of entries) {
      entry.search = { at: startedAt, indexers: [], candidates: 0, accepted: 0, result: null, topRejections: [], nextAt: null, rejected: [] };
      queue.enter(entry, 'searching', 'search started');
    }
    let open = entries;
    let asked = 0;
    let answered = 0;
    // Every decision of each entry, so the log of a target says why each release did not match.
    const all = new Map<string, Decision[]>();
    const foundReleases = new Set<string>();
    const manual = payload.manual === true;
    // A manual search is for a target that the user selected. It runs without the automatic budget and the recent window.
    // The budget is for a season search: a movie has no episode queries to defer. The manual search of the other seasons
    // of the releases asks a few seasons, and it ends with its targets where they are.
    const budget = manual || payload.otherSeasons || title.mediaType === 'movie' ? null : { left: SEARCH_BUDGET };
    const resume = manual ? undefined : payload.resume;
    const runId = newRequestId().replace('req-', 'run-');
    const names = titleNames(title);

    // The last line of a series run: it says the state of the whole series when no target of the title still has work.
    const noteSeriesFinished = () => {
      if (title.mediaType === 'movie') return;
      const active = Object.values(db.data.queue).filter((entry) => entry.titleKey === title.key && isActive(entry));
      const pending = active.some((entry) => entry.state.kind === 'searching' || entry.state.kind === 'paused' || entry.state.kind === 'queued');
      if (pending) return;
      const waiting = active.filter((entry) => entry.state.kind === 'waiting');
      const next = waiting.flatMap((entry) => (entry.search?.nextAt == null ? [] : [entry.search.nextAt]));
      const accepted = entries.filter((entry) => entry.release !== null).length;
      catalog.info('finished', `Series search finished: ${active.length} targets, ${accepted} accepted`, titleFields(title), {
        scope: 'series',
        targets: active.length,
        accepted,
        waiting: waiting.length,
        releases: foundReleases.size,
        nextSearchAt: next.length ? new Date(Math.min(...next)).toISOString() : null,
        run: runId,
      });
    };

    // The closest decision of each release. A release can come from more than one want, and the one with the fewest
    // reasons is the one that says why it did not match.
    const closestOf = (list: Decision[]) => {
      const closest = new Map<string, Decision>();
      for (const decision of list) {
        const key = `${decision.release.indexerId}:${decision.release.guid}`;
        const current = closest.get(key);
        if (!current || decision.rejections.length < current.rejections.length) closest.set(key, decision);
      }
      return [...closest.values()];
    };
    const resultsOf = (count: number) => `${count} ${count === 1 ? 'result' : 'results'} found`;

    // Takes the best accepted release of each entry. A release that several entries accept is taken once, for all of them.
    // Returns the entries that got no release.
    const grabBest = (group: QueueEntry[], decisionsOf: (entry: QueueEntry) => Decision[]) => {
      const byRelease = new Map<string, { decision: Decision; entries: QueueEntry[] }>();
      const left: QueueEntry[] = [];
      for (const entry of group) {
        const best = bestOf(decisionsOf(entry));
        if (!best) left.push(entry);
        else {
          const key = `${best.release.indexerId}:${best.release.guid}`;
          const slot = byRelease.get(key) ?? { decision: best, entries: [] };
          slot.entries.push(entry);
          byRelease.set(key, slot);
        }
      }
      for (const { decision, entries: slot } of byRelease.values()) if (!reserve(slot, decision)) left.push(...slot);
      return left;
    };

    // Asks the indexers and decides for each entry. The line says what the query returned and what it accepted, so a
    // reader can tell a season answer with rejected packs from an empty individual answer.
    const ask = async (scope: Scope, name: TitleName, group: QueueEntry[], wantsOf: (entry: QueueEntry) => Want[]) => {
      const result = await queryAll(title, scope, name, group, signal, { fresh: payload.fresh, quiet: scope.kind !== 'movie', ...(budget ? { budget } : {}) });
      asked = Math.max(asked, result.asked);
      answered += result.answered;
      for (const release of result.releases) foundReleases.add(`${release.indexerId}:${release.guid}`);
      const decisions = new Map<string, Decision[]>();
      for (const entry of group) {
        const list = wantsOf(entry).flatMap((want) => result.releases.map((release) => decide(release, want, ctx)));
        decisions.set(entry.id, list);
        all.set(entry.id, [...(all.get(entry.id) ?? []), ...list]);
        entry.search!.candidates = Math.max(entry.search!.candidates, result.releases.length);
      }
      if (scope.kind !== 'movie') {
        const provenance = { name: name.value, ...(name.alias ? { languages: name.languages } : {}), requests: result.requests, run: runId, ...(result.incomplete ? { incomplete: true } : {}) };
        const partial = result.incomplete ? '; request budget reached' : '';
        const search = name.alias ? 'Search alias' : scope.kind === 'season' ? 'Search season' : 'Search episode';
        const label = scope.kind === 'season' ? `${search} "${name.value}"` : `${search} ${scopeText(scope, name.value)}`;
        if (scope.kind === 'season') {
          const releases = closestOf(group.flatMap((entry) => decisions.get(entry.id) ?? []));
          const accepted = releases.filter((decision) => decision.accepted).length;
          const acceptedTargets = group.filter((entry) => (decisions.get(entry.id) ?? []).some((decision) => decision.accepted)).length;
          const reasons = rejectionSummary(releases.filter((decision) => !decision.accepted));
          catalog.info('search', `${label}: ${resultsOf(result.releases.length)}, ${accepted} matched quality${partial}`, titleFields(title), {
            ...provenance,
            source: 'season',
            scope: `S${pad(scope.season)}`,
            season: scope.season,
            releases: result.releases.length,
            accepted,
            targets: group.length,
            acceptedTargets,
            reasons,
          });
          for (const entry of group) {
            const own = closestOf(decisions.get(entry.id) ?? []);
            const ownAccepted = own.filter((decision) => decision.accepted).length;
            const ownReasons = rejectionSummary(own.filter((decision) => !decision.accepted));
            catalog.info('search', `${label} for S${pad(entry.season!)}E${pad(entry.number!)}: ${resultsOf(own.length)}, ${ownAccepted} matched quality${partial}`, itemFields(entry), {
              ...provenance,
              source: 'season',
              scope: `S${pad(scope.season)}`,
              season: scope.season,
              releases: own.length,
              accepted: ownAccepted,
              reasons: ownReasons,
            });
          }
        } else {
          const entry = group[0]!;
          const own = closestOf(decisions.get(entry.id) ?? []);
          const ownAccepted = own.filter((decision) => decision.accepted).length;
          const ownReasons = rejectionSummary(own.filter((decision) => !decision.accepted));
          catalog.info('search', `${label}: ${resultsOf(result.releases.length)}, ${ownAccepted} matched quality${partial}`, itemFields(entry), {
            ...provenance,
            source: 'episode',
            season: entry.season,
            number: entry.number,
            releases: result.releases.length,
            accepted: ownAccepted,
            reasons: ownReasons,
          });
        }
      }
      return { decisionsOf: (entry: QueueEntry) => decisions.get(entry.id) ?? [], releases: result.releases, incomplete: result.incomplete };
    };

    // An episode in the recent window keeps its individual query. The season query covers an older season only.
    const recentEpisode = (entry: QueueEntry) => {
      const episode = title.episodes.find((item) => item.season === entry.season && item.number === entry.number);
      const at = episodeEligibleAt(episode?.airDate ?? null);
      return at !== null && at <= now() && now() - at < recentAirMs;
    };
    const noteSkipped = (entry: QueueEntry) => {
      catalog.info('search', 'Search episode skipped: the episode is too old to be a recent episode, so only the season search ran.', itemFields(entry), {
        source: 'episode',
        skipped: true,
        reason: 'outside_recent_window',
        run: runId,
        season: entry.season,
        number: entry.number,
      });
    };

    // Stops this run at the budget. The targets still wait, and a new job continues the search soon. The season
    // queries run again from the cache, so the next run spends its budget on the queries that did not run yet.
    const defer = (next?: SearchResume) => {
      const remaining = open.filter((entry) => entry.state.kind === 'searching');
      if (!remaining.length) return;
      const nextAt = now() + SEARCH_CONTINUE_MS;
      for (const entry of remaining) {
        Object.assign(entry.search!, { result: 'deferred', accepted: 0, nextAt });
        catalog.info('search_deferred', 'Search deferred: request budget reached. The search continues in the next run.', itemFields(entry), {
          result: 'deferred',
          nextSearchAt: new Date(nextAt).toISOString(),
          run: runId,
        });
        queue.wait(entry, 'deferred', 'search deferred', 'budget');
      }
      enqueueSearch({ titleKey: payload.titleKey, season: payload.season, entryIds: remaining.map((entry) => entry.id), ...(next ? { resume: next } : {}) }, { runAt: nextAt, afterRun: true });
    };

    // The seasons of the releases that can hold the episodes that the season of the title misses. The season of the pack
    // that a target remembers comes first, then the season of the title, then the seasons after it.
    const candidateSeasons = (season: number, group: QueueEntry[]) => {
      const list: number[] = [];
      const add = (value: number | null | undefined) => {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 99 || list.includes(value)) return;
        list.push(value);
      };
      for (const entry of group) {
        add(entry.partialPack?.releaseSeason);
        add(entry.continuation?.releaseSeason);
      }
      add(season);
      for (let next = season + 1; next <= Math.min(season + 4, 99); next++) add(next);
      return list;
    };

    // The mapping that a target uses for a release season. The mapping that the target stores comes first. A release
    // season with no stored mapping starts at the first episode of its season, and the files of the pack establish the
    // real mapping at the grab.
    const mappingFor = (season: number, entry: QueueEntry, releaseSeason: number): Continuation | null => {
      if (releaseSeason === season) return null;
      const known = entry.continuation;
      if (known && known.releaseSeason === releaseSeason && known.season === season) return known;
      return { releaseSeason, season, from: 1 };
    };

    // The manual search of the other seasons of the releases. A release counts its seasons in its own way: a pack that it
    // names as another season can hold the files of the episodes that the season of the title misses. The files of the
    // pack return to their target through the mapping of the pack, which the grab establishes.
    async function otherSeasons(group: QueueEntry[], signal: AbortSignal) {
      const season = group[0]?.season ?? null;
      if (season === null) {
        noResult(group, title, () => [], 0, 0, 0, profiles, { partial: true });
        return;
      }
      for (const releaseSeason of candidateSeasons(season, group)) {
        if (!open.length) break;
        const wantsOf = (entry: QueueEntry): Want[] => {
          const continuation = mappingFor(season, entry, releaseSeason);
          const seasonWant: Want = { kind: 'season', title, season, ...(continuation ? { continuation } : {}) };
          const episodeWant: Want = { kind: 'episode', title, season, number: entry.number!, ...(continuation ? { continuation } : {}) };
          return [seasonWant, episodeWant];
        };
        for (const name of names) {
          const targets = open.filter((entry) => entry.state.kind === 'searching');
          if (!targets.length) break;
          const result = await ask({ kind: 'season', season: releaseSeason }, name, targets, wantsOf);
          const pack = bestOf(targets.flatMap((entry) => result.decisionsOf(entry).filter((decision) => decision.kind === 'pack')));
          if (pack) {
            const covered = targets.filter((entry) => pack.covers.some((candidate) => candidate.season === entry.season && candidate.number === entry.number));
            if (covered.length && reserve(covered, pack)) open = open.filter((entry) => !covered.includes(entry));
          }
          open = grabBest(open, (entry) => result.decisionsOf(entry).filter((decision) => decision.kind !== 'pack'));
          // A name that returns releases is not a solution: the next name of the title can still hold the targets that
          // this one does not cover, so the loop goes on while a target is open.
        }
        // The episodes of the release season also arrive one file at a time. That query needs the numbering of the
        // season: a release season with no stored mapping gives no number to ask for.
        for (const entry of [...open]) {
          if (!open.includes(entry) || entry.state.kind !== 'searching') continue;
          const known = entry.continuation && entry.continuation.releaseSeason === releaseSeason && entry.continuation.season === season ? entry.continuation : null;
          if (releaseSeason !== season && !known) continue;
          const releaseNumber = known ? entry.number! - known.from + 1 : entry.number!;
          if (releaseNumber < 1) continue;
          for (const name of names) {
            const want: Want = { kind: 'episode', title, season, number: entry.number!, ...(known ? { continuation: known } : {}) };
            const single = await ask({ kind: 'episode', season: releaseSeason, number: releaseNumber }, name, [entry], () => [want]);
            grabBest([entry], single.decisionsOf);
            // The target stops asking names when it has its release. A name that gives nothing, or releases that do not
            // fit, leaves the next name its chance.
            if (entry.state.kind !== 'searching') break;
          }
          // A target that got its release left the search. The others stay in it, so the end of the run keeps them.
          if (entry.state.kind !== 'searching') open = open.filter((item) => item !== entry);
        }
      }
      // A manual import can settle a target while the indexers answer. That target is done, so it does not go back.
      open = open.filter((entry) => entry.state.kind === 'searching');
      if (!open.length) {
        noteSeriesFinished();
        return;
      }
      if (asked > 0 && answered === 0 && !final) {
        for (const entry of open) queue.wait(entry, 'indexers_failed', 'indexers failed');
        throw new JobError('outage', 'No indexer answered.');
      }
      // The targets that found no file stay where they were. The run queues no search of another season after it ends.
      noResult(open, title, (entry) => all.get(entry.id) ?? [], asked, answered, foundReleases.size, profiles, { partial: true });
      noteSeriesFinished();
    }

    // The folder of the title is read before any indexer is asked. A series that is on the disk never downloads again.
    // A root that cannot be read stops its targets here, so they wait instead of downloading a second copy.
    const local = await importLocal({ queue, clients }, { titleKey: title.key, entryIds: entries.map((entry) => entry.id) });
    open = open.filter((entry) => entry.state.kind === 'searching' && !local.blocked.includes(entry.id));
    if (!open.length) {
      noteSeriesFinished();
      return;
    }

    if (title.mediaType === 'movie') {
      for (const name of names) {
        if (!open.length) break;
        const result = await ask({ kind: 'movie' }, name, open, (entry) => [wantFor(title, entry)]);
        open = grabBest(open, result.decisionsOf);
        // A name that returns releases is the name of the search. The aliases after it do not run.
        if (result.releases.length) break;
      }
    } else if (payload.otherSeasons) {
      // The manual search of the other seasons of the releases. It ends the run: the targets that found no file stay
      // stuck, and no search of another season comes after it.
      await otherSeasons(open, signal);
      return;
    } else {
      const season = payload.season;
      const counts: number[] = [];
      // The season queries come first. They give the packs, the singles, and the number of releases of each name,
      // which selects the name of the individual queries.
      if (!manual && season !== null && open.length > 1 && resume?.phase !== 'absolute') {
        for (const name of names) {
          const group = open;
          if (!group.length || open.length <= 1) break;
          if (budget && budget.left <= 0) {
            defer();
            return;
          }
          const result = await ask({ kind: 'season', season }, name, group, (entry) => [{ kind: 'season', title, season }, wantFor(title, entry)]);
          counts.push(result.releases.length);
          const pack = bestOf(group.flatMap((entry) => result.decisionsOf(entry).filter((decision) => decision.kind === 'pack')));
          if (pack) {
            // The pack covers the episodes that it names. The other targets keep their own searches.
            const covered = group.filter((entry) => pack.covers.some((c) => c.season === entry.season && c.number === entry.number));
            // The files of an earlier download can hold none of these targets, and then the pack gives nothing here.
            if (covered.length && reserve(covered, pack)) open = open.filter((entry) => !covered.includes(entry));
          }
          open = grabBest(open, (entry) => result.decisionsOf(entry).filter((decision) => decision.kind !== 'pack'));
          if (result.incomplete) {
            defer();
            return;
          }
          // A name that returns releases is the name of the search. The aliases after it do not run.
          if (result.releases.length) break;
        }
      }

      // The recent window and a search with one target decide which episodes keep an individual query.
      const targets = open.filter((entry) => manual || open.length === 1 || recentEpisode(entry));
      const skipped = open.filter((entry) => !targets.includes(entry));
      if (!resume) for (const entry of skipped) noteSkipped(entry);

      if (resume?.phase !== 'absolute') {
        if (manual) {
          // The user selected the target. Try each name until one of them returns releases.
          for (const entry of [...targets]) {
            if (!open.includes(entry) || entry.state.kind !== 'searching') continue;
            for (const name of names) {
              const result = await ask({ kind: 'episode', season: entry.season!, number: entry.number! }, name, [entry], (item) => [wantFor(title, item)]);
              grabBest([entry], result.decisionsOf);
              // A name that returns releases is the name of the search. The aliases after it do not run.
              if (result.releases.length) break;
            }
          }
        } else {
          // One name for the individual queries: the one with the most releases in the season answers.
          let selected = 0;
          for (let index = 1; index < counts.length; index++) if ((counts[index] ?? 0) > (counts[selected] ?? 0)) selected = index;
          if (selected >= names.length) selected = 0;
          const start = resume?.phase === 'episode' ? Math.max(0, targets.findIndex((entry) => entry.id === resume.entryId)) : 0;
          for (let index = start; index < targets.length; index++) {
            const entry = targets[index]!;
            if (!open.includes(entry) || entry.state.kind !== 'searching') continue;
            if (budget && budget.left <= 0) {
              defer({ phase: 'episode', entryId: entry.id });
              return;
            }
            const result = await ask({ kind: 'episode', season: entry.season!, number: entry.number! }, names[selected]!, [entry], (item) => [wantFor(title, item)]);
            if (!grabBest([entry], result.decisionsOf).length) open = open.filter((item) => item !== entry);
            if (result.incomplete) {
              defer({ phase: 'episode', entryId: entry.id });
              return;
            }
          }
        }
      }

      // The second numbering scheme: the absolute number of an Anime episode, only when the first scheme gave nothing.
      if (open.length && title.seriesType === 'anime') {
        const absoluteTargets = open.filter((entry) => manual || open.length === 1 || recentEpisode(entry));
        const start = resume?.phase === 'absolute' ? Math.max(0, absoluteTargets.findIndex((entry) => entry.id === resume.entryId)) : 0;
        for (let index = start; index < absoluteTargets.length; index++) {
          const entry = absoluteTargets[index]!;
          if (!open.includes(entry) || entry.state.kind !== 'searching') continue;
          if (budget && budget.left <= 0) {
            defer({ phase: 'absolute', entryId: entry.id });
            return;
          }
          const absolute = absoluteNumber(title, entry.season!, entry.number!);
          const result = await ask({ kind: 'absolute', number: absolute }, names[0]!, [entry], (item) => [wantFor(title, item)]);
          if (!grabBest([entry], result.decisionsOf).length) open = open.filter((item) => item !== entry);
          if (result.incomplete) {
            defer({ phase: 'absolute', entryId: entry.id });
            return;
          }
        }
      }
    }

    // A manual import can settle a target while the indexers answer. That target is done, so it does not go back to the queue.
    open = open.filter((entry) => entry.state.kind === 'searching');
    if (!open.length) {
      noteSeriesFinished();
      return;
    }
    // Every indexer failed: the job tries again with a backoff, because the cause may pass soon. The target waits for
    // the next run, and its row shows Searching.
    if (asked > 0 && answered === 0 && !final) {
      for (const entry of open) queue.wait(entry, 'indexers_failed', 'indexers failed');
      throw new JobError('outage', 'No indexer answered.');
    }
    noResult(open, title, (entry) => all.get(entry.id) ?? [], asked, answered, foundReleases.size, profiles);
    // A target that still waits keeps its next search in the queue, so the page shows the future work now.
    const waiting = open.filter((entry) => entry.state.kind === 'waiting' && entry.search?.nextAt);
    const seasons = new Map<number | null, QueueEntry[]>();
    for (const entry of waiting) seasons.set(entry.season, [...(seasons.get(entry.season) ?? []), entry]);
    for (const group of seasons.values()) {
      const nextAt = Math.min(...group.map((entry) => entry.search!.nextAt!));
      enqueueSearch({ titleKey: group[0]!.titleKey, season: group[0]!.season, entryIds: group.map((entry) => entry.id) }, { runAt: nextAt, afterRun: true });
    }
    noteSeriesFinished();
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
    const scope: Scope = season === null ? { kind: 'movie' } : { kind: 'episode', season, number: number! };
    const want: Want = season === null ? { kind: 'movie', title, upgradeQuality: quality } : { kind: 'episode', title, season, number: number!, upgradeQuality: quality };
    for (const name of titleNames(title)) {
      const found = await queryAll(title, scope, name, [], signal, { fresh: true });
      if (!stillUpgrade(title, season, number, quality)) break;
      const best = bestOf(found.releases.map((release) => decide(release, want, decideContext())));
      if (best) {
        const entry = queue.ensure(title.key, season, number);
        if (queue.request(entry, 'upgrade search')) reserve([entry], best);
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
    type Slot = { title: Title; wants: { want: Want; entry: () => QueueEntry }[] };
    // The library titles that have a target to fill, found by each of their names.
    const byName = new Map<string, Set<Slot>>();
    for (const title of Object.values(db.data.titles)) {
      if (title.paused) continue;
      const wants: Slot['wants'] = [];
      if (title.mediaType === 'movie') {
        if (wantedMovie(title)) wants.push({ want: { kind: 'movie', title }, entry: () => queue.ensure(title.key, null, null) });
      } else {
        for (const episode of title.episodes) {
          if (wantedEpisode(title, episode)) wants.push({ want: { kind: 'episode', title, season: episode.season, number: episode.number }, entry: () => queue.ensure(title.key, episode.season, episode.number) });
        }
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
    const best = new Map<string, { decision: Decision; entry: () => QueueEntry }>();
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
            for (const { want, entry } of slot.wants) {
              const decision = decide(release, want, ctx);
              if (!decision.accepted) continue;
              const key = want.kind === 'movie' ? want.title.key : `${want.title.key}:${(want as Extract<Want, { kind: 'episode' }>).season}x${(want as Extract<Want, { kind: 'episode' }>).number}`;
              const current = best.get(key);
              if (!current || bestOf([current.decision, decision]) === decision) best.set(key, { decision, entry });
            }
          }
        }
      }
    }
    for (const { decision, entry } of best.values()) {
      const target = entry();
      // A target that the user cancelled stays out of the queue. The user starts it again.
      if (target.state.kind === 'cancelled') continue;
      // The entry may be in the journey already, or waiting. A release that RSS found ends the wait.
      if (target.state.kind === 'waiting') queue.enter(target, 'queued', 'found by RSS');
      else if (!queue.request(target, 'found by RSS')) continue;
      reserve([target], decision);
    }
  }

  // --- Sweep ------------------------------------------------------------------------------

  // A target that stopped before its import, on a file of its pack or on a torrent that left the client, goes back to
  // the search after a delay. A mount or a path that ladarr cannot see is not one of these: a new download blocks again.
  // A target that stopped in Validating or Importing stays stuck, so the person resolves the problem there.
  const REPAIR = new Set(['file_not_found', 'torrent_missing']);
  const REPAIR_MS = 30 * 60_000;

  function repairBlocked(titleKey?: string) {
    const t = now();
    const again = new Map<string, { titleKey: string; season: number | null; entryIds: string[] }>();
    for (const entry of Object.values(db.data.queue)) {
      if (titleKey && entry.titleKey !== titleKey) continue;
      if (!isActive(entry) || entry.state.kind === 'paused' || entry.state.kind === 'cancelled') continue;
      if (entry.state.kind !== 'blocked') continue;
      const problem = entry.state.problem;
      const at = entry.state.at;
      if (!REPAIR.has(problem.code) || at === 'validating' || at === 'importing') continue;
      if (t - entry.stateSince < REPAIR_MS) continue;
      catalog.info('repair', `The import stopped on ${problem.code}. The search starts again.`, itemFields(entry), { code: problem.code });
      queue.endAttempt(entry, 'failed', 'verification repair');
      queue.fallback(entry, 'verification repair', problem.code, 'verification repair');
      const key = `${entry.titleKey}|${entry.season ?? ''}`;
      const group = again.get(key) ?? { titleKey: entry.titleKey, season: entry.season, entryIds: [] };
      group.entryIds.push(entry.id);
      again.set(key, group);
    }
    for (const { titleKey, season, entryIds } of again.values()) enqueueSearch({ titleKey, season, entryIds, fresh: true });
  }

  // A target whose attempt runs but that no search job holds is work that a lost job left behind: the app stopped in
  // the middle of a search, or a job went before it opened its targets. The search starts again, so the target does not
  // wait forever with no work.
  function recoverLost() {
    const held = new Set<string>();
    for (const job of Object.values(db.data.jobs)) {
      if (job.type !== 'queue.search' || (job.state !== 'waiting' && job.state !== 'running')) continue;
      for (const id of (job.payload as SearchPayload).entryIds) held.add(id);
    }
    const again = new Map<string, { titleKey: string; season: number | null; entryIds: string[]; otherSeasons: boolean }>();
    for (const entry of Object.values(db.data.queue)) {
      if (entry.state.kind !== 'queued' || entry.attempt === 0) continue;
      if (held.has(entry.id) || entry.attempts.at(-1)?.outcome !== 'running') continue;
      const title = db.data.titles[entry.titleKey];
      if (!title || title.paused) continue;
      catalog.warn('repair', 'The search of this target was lost. It starts again.', itemFields(entry), { code: 'lost_search' });
      const attempt = entry.attempts.at(-1);
      queue.retryAttempt(entry, 'lost search');
      const key = `${entry.titleKey}|${entry.season ?? ''}`;
      const group = again.get(key) ?? { titleKey: entry.titleKey, season: entry.season, entryIds: [], otherSeasons: attempt?.reason === OTHER_SEASONS_REASON };
      group.entryIds.push(entry.id);
      again.set(key, group);
    }
    for (const { titleKey, season, entryIds, otherSeasons } of again.values()) enqueueSearch({ titleKey, season, entryIds, fresh: true, ...(otherSeasons ? { otherSeasons: true } : {}) });
  }

  // Starts the search again for entries that waited long enough. Starts the search for every target that is due.
  function sweep() {
    const t = now();
    // A group where every target found no release goes last: a new release is its only next step, so another group
    // with work gets the indexers first. The sort is stable, so the other groups keep their order.
    const foundNothing = (group: { entryIds: string[] }) => group.entryIds.every((id) => {
      const entry = db.data.queue[id];
      return entry !== undefined && entry.state.kind === 'waiting' && entry.state.outcome === 'no_results';
    });
    const lastIfNotFound = <T extends { entryIds: string[] }>(list: T[]) => list.sort((a, b) => Number(foundNothing(a)) - Number(foundNothing(b)));
    // Every target that waits keeps its next search in the queue, so the future work is visible at once.
    const waiting = new Map<string, { titleKey: string; season: number | null; entryIds: string[]; nextAt: number }>();
    for (const entry of Object.values(db.data.queue)) {
      if (entry.state.kind !== 'waiting' || !entry.search?.nextAt) continue;
      const title = db.data.titles[entry.titleKey];
      if (!title || title.paused) continue;
      const key = `${entry.titleKey}|${entry.season ?? ''}`;
      const group = waiting.get(key) ?? { titleKey: entry.titleKey, season: entry.season, entryIds: [], nextAt: Number.POSITIVE_INFINITY };
      group.entryIds.push(entry.id);
      group.nextAt = Math.min(group.nextAt, entry.search.nextAt);
      waiting.set(key, group);
    }
    // A future search that no target waits for is not work. Drop it, so the queue stays honest.
    for (const job of Object.values(db.data.jobs)) {
      if (job.type !== 'queue.search' || job.state !== 'waiting' || job.runAt <= t) continue;
      const payload = job.payload as SearchPayload;
      const wanted = payload.entryIds.some((id) => {
        const entry = db.data.queue[id];
        const title = entry ? db.data.titles[entry.titleKey] : undefined;
        return entry?.state.kind === 'waiting' && Boolean(title && !title.paused);
      });
      if (!wanted) delete db.data.jobs[job.id];
    }
    // The repair runs after the cleanup of the future work. Its jobs are work of now, and the cleanup of the old state
    // must not see them and take them for future searches that no target waits for.
    repairBlocked();
    recoverLost();
    for (const { titleKey, season, entryIds, nextAt } of lastIfNotFound([...waiting.values()])) enqueueSearch({ titleKey, season, entryIds }, { runAt: nextAt, afterRun: true });

    // The targets that are due, a season at a time. One request covers the season and its pack, also when it arrives later.
    const again = new Map<string, { titleKey: string; season: number | null; entryIds: string[] }>();
    for (const entry of Object.values(db.data.queue)) {
      if (entry.state.kind !== 'waiting' || !entry.search?.nextAt || entry.search.nextAt > t) continue;
      const key = `${entry.titleKey}|${entry.season ?? ''}`;
      const group = again.get(key) ?? { titleKey: entry.titleKey, season: entry.season, entryIds: [] };
      group.entryIds.push(entry.id);
      again.set(key, group);
    }
    for (const { titleKey, season, entryIds } of lastIfNotFound([...again.values()])) requestSearch(titleKey, { season: season ?? undefined, reason: 'search again', only: new Set(entryIds) });

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

  // The target that a release names. A pack covers its season, an episode covers itself, and a release that does not
  // say which episode it has falls back to the target that the user opened.
  function wantForRelease(title: Title, release: RawRelease, season?: number, number?: number): Want | undefined {
    if (title.mediaType === 'movie') return { kind: 'movie', title };
    const parsed = parseRelease(release.title);
    if (parsed.pack && parsed.season !== null) return { kind: 'season', title, season: parsed.season };
    const first = parsed.episodes[0];
    if (parsed.season !== null && first !== undefined) return { kind: 'episode', title, season: parsed.season, number: first };
    return number !== undefined && season !== undefined ? { kind: 'episode', title, season, number } : undefined;
  }

  // Searches for the user to look at. It uses the interactive switch of the indexer and creates no queue entry.
  async function interactive(titleKey: string, { season, number, fresh }: { season?: number; number?: number; fresh?: boolean }, signal: AbortSignal) {
    const title = db.data.titles[titleKey];
    if (!title) return;
    const scope: Scope = title.mediaType === 'movie' ? { kind: 'movie' } : number !== undefined && season !== undefined ? { kind: 'episode', season, number } : { kind: 'season', season: season ?? 1 };
    // The aliases are asked only when the names before gave no release.
    const releases: RawRelease[] = [];
    let asked = 0;
    let answered = 0;
    for (const name of titleNames(title)) {
      const found = await queryAll(title, scope, name, [], signal, { forUser: true, fresh });
      asked = Math.max(asked, found.asked);
      answered += found.answered;
      releases.push(...found.releases);
      if (releases.length) break;
    }
    const ctx = decideContext();
    const decisions = releases.flatMap((release) => {
      const want = wantForRelease(title, release, season, number);
      if (!want) return [];
      return [{ decision: decide(release, want, ctx), want }];
    });
    return { decisions, asked, answered };
  }

  // Grabs a release that the user chose. A person can take any release by hand, also one that the automatic search
  // rejected.
  function grabManual(entries: QueueEntry[], release: RawRelease, want: Want) {
    const decision = decide(release, want, decideContext(true));
    for (const entry of entries) {
      if (entry.state.kind === 'waiting') queue.enter(entry, 'queued', 'release chosen by the user');
      else queue.request(entry, 'release chosen by the user');
    }
    return reserve(entries, decision, true) ? { reserved: true } : { rejections: ['already_downloading'] };
  }

  // --- Failures ---------------------------------------------------------------------------

  const MAX_ATTEMPTS = 3;

  // The episodes that the pack lacks, in the log line that records it. The reason alone does not say which one was missing.
  const packDetail = (missing: QueueEntry[], files: number) => ({ files, missing: missing.map((entry) => `${entry.season}x${entry.number}`) });

  // A pack that holds a part of its season: `missing` are the targets of the pack that its files do not cover. The record
  // of the files keeps the episodes that it holds, so a later search does not take the pack again for the others. A pack
  // whose files name no episode holds nothing of the season, and the empty record keeps it out of the searches. The
  // missing targets stop, and the user starts the search of the other seasons of the releases from the card of the
  // season. Nothing searches another season by itself. Returns the targets that the pack covers.
  function partial(entries: QueueEntry[], missing: QueueEntry[], { files, releaseSeason, numbers }: { files: number; releaseSeason?: number | null; numbers?: number[] }) {
    const leader = entries[0];
    const ref = leader?.release ?? null;
    const season = missing[0]?.season ?? null;
    if (leader && ref && season !== null) {
      db.data.releaseCoverage[`${ref.indexerId}:${ref.guid}`] = {
        titleKey: leader.titleKey,
        season,
        numbers: entries.filter((entry) => !missing.includes(entry) && entry.season === season).map((entry) => entry.number!),
      };
    }
    // A pack that names no episode holds nothing of the season, so it is a release that failed: the target tries its
    // season again. A pack that names its episodes and still misses some of its targets is a difference of numbering,
    // and that is a question for the user.
    if (!numbers?.length) {
      fallback(missing, 'pack_partial', packDetail(missing, files));
      return entries.filter((entry) => !missing.includes(entry));
    }
    for (const entry of missing) {
      catalog.warn('release_failed', `${entry.release ? `"${entry.release.title}"` : 'The release'} failed: pack_partial`, itemFields(entry), { code: 'pack_partial', release: entry.release?.title ?? null, ...packDetail(missing, files) });
      queue.endAttempt(entry, 'failed', 'pack_partial');
      Object.assign(entry, { release: null, transferHash: null, clientId: null });
      // The files of the pack say which season of the releases it is, so the manual search starts from that season.
      if (releaseSeason !== undefined) entry.partialPack = { releaseSeason, numbers: numbers ?? [] };
      queue.block(entry, { code: 'pack_partial' }, 'pack does not hold every episode', 'pack_partial');
    }
    return entries.filter((entry) => !missing.includes(entry));
  }

  // A pack of another season whose files give no mapping. It gives no file to this season, and its targets stop as a
  // partial pack gives them: the user starts the search of the other seasons again.
  function refusePack(entries: QueueEntry[], cause: string) {
    for (const entry of entries) {
      catalog.warn('release_failed', `${entry.release ? `"${entry.release.title}"` : 'The release'} failed: ${cause}`, itemFields(entry), { code: cause, release: entry.release?.title ?? null });
      queue.endAttempt(entry, 'failed', cause);
      Object.assign(entry, { release: null, transferHash: null, clientId: null });
      queue.block(entry, { code: 'pack_partial' }, 'pack does not hold every episode', cause);
    }
  }

  // The manual search of the other seasons of the releases, for the targets of one season that a pack left without a
  // file. It checks the targets again, so two requests at the same time start one search.
  function startOtherSeasons(entries: QueueEntry[]) {
    const bySeason = new Map<string, QueueEntry[]>();
    for (const entry of entries) {
      if (!needsOtherSeasons(entry.state)) continue;
      queue.retryAttempt(entry, OTHER_SEASONS_REASON);
      queue.enter(entry, 'queued', OTHER_SEASONS_REASON);
      const key = `${entry.titleKey}|${entry.season ?? ''}`;
      bySeason.set(key, [...(bySeason.get(key) ?? []), entry]);
    }
    for (const group of bySeason.values()) enqueueSearch({ titleKey: group[0]!.titleKey, season: group[0]!.season, entryIds: group.map((entry) => entry.id), fresh: true, otherSeasons: true });
    return [...bySeason.values()].flat();
  }


  // A release that the download confirmed bad ends the attempt. The entry goes back to Queued with a new attempt and a
  // new search. After a few attempts it asks for the user.
  function fallback(entries: QueueEntry[], cause: string, detail?: Record<string, unknown>) {
    const again: QueueEntry[] = [];
    for (const entry of entries) {
      catalog.warn('release_failed', `${entry.release ? `"${entry.release.title}"` : 'The release'} failed: ${cause}`, itemFields(entry), { code: cause, release: entry.release?.title ?? null, ...detail });
      queue.endAttempt(entry, 'failed', cause);
      Object.assign(entry, { release: null, transferHash: null, clientId: null });
      if (entry.attempt >= MAX_ATTEMPTS) {
        queue.block(entry, { code: 'too_many_attempts', detail: cause }, 'attempts used', cause);
        continue;
      }
      queue.fallback(entry, cause);
      again.push(entry);
    }
    const bySeason = new Map<string, QueueEntry[]>();
    for (const entry of again) bySeason.set(`${entry.titleKey}|${entry.season ?? ''}`, [...(bySeason.get(`${entry.titleKey}|${entry.season ?? ''}`) ?? []), entry]);
    // The targets need a new search, also when the search that chose the release is still running: that run has its own
    // list of targets, and it does not take these again.
    for (const group of bySeason.values()) enqueueSearch({ titleKey: group[0]!.titleKey, season: group[0]!.season, entryIds: group.map((e) => e.id) }, { afterRun: true });
  }

  return { requestSearch, reserve, fallback, partial, refusePack, startOtherSeasons, enqueueSearch, interactive, grabManual, wantForRelease, decideContext, usableIndexers, queryAll, wantedEpisode, wantedMovie, repairBlocked, sweep, rss, search, upgradeTitle, upgradeCount: (title: Title, quality: string) => upgradeFiles(title, quality).length, clearCache: () => cache.clear() };
}

export type Finder = ReturnType<typeof createFinder>;
