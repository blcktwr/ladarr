import type { Indexer } from '../../src/library/grab/indexers.ts';
import type { Episode, Title } from '../../src/library/library.ts';
import type { RawRelease } from '../../src/library/grab/torznab.ts';

export const NOW = Date.UTC(2024, 5, 1);

export const episode = (season: number, number: number, airDate: string | null = '2020-01-01', extra: Partial<Episode> = {}): Episode => ({
  tmdbId: season * 100 + number,
  season,
  number,
  name: `Episode ${number}`,
  airDate,
  runtime: 45,
  override: null,
  fileId: null,
  ...extra,
});

export const title = (extra: Partial<Title> = {}): Title => ({
  key: 'tv:1',
  mediaType: 'tv',
  tmdbId: 1,
  meta: { mediaType: 'tv', tmdbId: 1, title: 'Show Name', year: 2020, overview: '', posterPath: null, originalLanguage: 'en', originalTitle: 'Show Name', aliases: [], date: null, status: 'Returning Series', rating: null, votes: 0, backdropPath: null, runtime: 45, imdbId: null, tvdbId: 55, releaseDates: [], seasons: [] },
  refreshedAt: NOW,
  addedAt: NOW,
  paused: false,
  policy: 'all',
  futureFrom: 0,
  seriesType: 'standard',
  preset: null,
  rootId: 'root',
  folder: null,
  manualRelease: false,
  seasonOverrides: {},
  episodesLoadedAt: NOW,
  episodes: [],
  fileId: null,
  ...extra,
});

export const movie = (extra: Partial<Title> = {}): Title =>
  title({
    key: 'movie:2',
    mediaType: 'movie',
    tmdbId: 2,
    meta: { ...title().meta, mediaType: 'movie', tmdbId: 2, title: 'Movie Name', originalTitle: 'Movie Name', year: 2019, runtime: 100, tvdbId: null },
    ...extra,
  });

export const release = (name: string, extra: Partial<RawRelease> = {}): RawRelease => ({
  indexerId: 1,
  guid: name,
  title: name,
  link: `http://indexer/1/download?file=${encodeURIComponent(name)}`,
  magnet: null,
  infoHash: null,
  // About 60 MiB per minute for 45 minutes: the preferred size of a 1080p WEB-DL.
  sizeBytes: 60 * 45 * 1024 * 1024,
  publishedAt: null,
  seeders: 10,
  peers: 12,
  categories: [],
  ...extra,
});

export const indexer = (extra: Partial<Indexer> = {}): Indexer => {
  const push = { name: 'Tracker', enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, priority: 25, categories: [5030, 5040], animeCategories: [5070], minimumSeeders: 1, tags: [], fields: {} };
  return {
    id: 1,
    baseUrl: 'http://indexer:9696/1/',
    apiPath: '/api',
    apiKey: 'key',
    delaySeconds: 0,
    nextRequestAt: 0,
    preferredLanguages: [],
    push: { sonarr: push, radarr: { ...push, categories: [2040, 2045] } },
    caps: null,
    capsAt: 0,
    health: { okAt: null, failedAt: null, failures: 0, retryAt: 0, error: null },
    ...extra,
  };
};
