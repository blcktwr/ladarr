// A fake Seerr for the tests. It sends the same requests as Seerr 3.5.1 (tag v3.5.1, commit 564bfb0) sends to Sonarr and Radarr.
// The code follows these files of the Seerr source, in the folder server/:
//   api/externalapi.ts and api/servarr/base.ts: the API key in the query parameter apikey, the JSON headers, status, profiles, root folders, tags, queue, commands.
//   api/servarr/radarr.ts: lookup, add, update, search, remove.
//   api/servarr/sonarr.ts: lookup, add, update, episodes, search, remove.
//   subscriber/MediaRequestSubscriber.ts: the options that a request gives to addMovie and addSeries.
// This is not Seerr. It is a replay of the requests that the source shows. A test with it does not prove that a running Seerr works.

export class HttpError extends Error {
  status: number;
  data: any;
  constructor(status: number, data: unknown) {
    // axios words the message like this.
    super(`Request failed with status code ${status}`);
    this.status = status;
    this.data = data;
  }
}

// axios keeps these characters in a query value.
const encode = (value: string) => encodeURIComponent(value).replace(/%3A/gi, ':').replace(/%24/g, '$').replace(/%2C/gi, ',').replace(/%20/g, '+').replace(/%5B/gi, '[').replace(/%5D/gi, ']');

type Params = Record<string, string | number | boolean>;

class Servarr {
  // Each call as "METHOD /path?query", without the API key.
  calls: string[] = [];
  baseUrl: string;
  apiKey: string;
  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  protected async request(method: string, path: string, { params = {}, body }: { params?: Params; body?: unknown } = {}): Promise<any> {
    const query = (extra: Params) => Object.entries(extra).map(([name, value]) => `${name}=${encode(String(value))}`).join('&');
    this.calls.push(`${method} ${path}${Object.keys(params).length ? `?${query(params)}` : ''}`);
    const res = await fetch(`${this.baseUrl}${path}?${query({ apikey: this.apiKey, ...params })}`, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => undefined);
    if (!res.ok) throw new HttpError(res.status, data);
    return data;
  }

  getSystemStatus = () => this.request('GET', '/system/status');
  getProfiles = () => this.request('GET', '/qualityProfile');
  getRootFolders = () => this.request('GET', '/rootfolder');
  getTags = () => this.request('GET', '/tag');
  createTag = (label: string) => this.request('POST', '/tag', { body: { label } });
  renameTag = (id: number, label: string) => this.request('PUT', `/tag/${id}`, { body: { id, label } });
  getQueue = async () => (await this.request('GET', '/queue', { params: { includeEpisode: true } })).records;
  refreshMonitoredDownloads = () => this.runCommand('RefreshMonitoredDownloads', {});
  runCommand = (name: string, options: Record<string, unknown>) => this.request('POST', '/command', { body: { name, ...options } });
  // Not in the Seerr source. Other callers read the state of a command.
  getCommand = (id: number) => this.request('GET', `/command/${id}`);
}

export type RadarrMovieOptions = { title: string; qualityProfileId: number; minimumAvailability: string; tags: number[]; profileId: number; year: number; rootFolderPath: string; tmdbId: number; monitored?: boolean; searchNow?: boolean };

export class FakeRadarr extends Servarr {
  getMovies = () => this.request('GET', '/movie');
  getLibraryMoviesByTmdbId = (tmdbId: number) => this.request('GET', '/movie', { params: { tmdbId } });
  getMovie = (id: number) => this.request('GET', `/movie/${id}`);

  async getMovieByTmdbId(id: number) {
    const data = await this.request('GET', '/movie/lookup', { params: { term: `tmdb:${id}` } });
    if (!data[0]) throw new Error('Movie not found');
    return data[0];
  }

  // radarr.ts, addMovie. The three branches are the same: file exists, unmonitored copy exists, monitored copy exists, new.
  async addMovie(options: RadarrMovieOptions) {
    const movie = await this.getMovieByTmdbId(options.tmdbId);
    if (movie.hasFile) return movie;

    if (movie.id && !movie.monitored) {
      const response = await this.request('PUT', '/movie', {
        body: {
          ...movie,
          title: options.title,
          qualityProfileId: options.qualityProfileId,
          profileId: options.profileId,
          titleSlug: options.tmdbId.toString(),
          minimumAvailability: options.minimumAvailability,
          tmdbId: options.tmdbId,
          year: options.year,
          tags: Array.from(new Set([...movie.tags, ...options.tags])),
          rootFolderPath: options.rootFolderPath,
          monitored: options.monitored,
          addOptions: { searchForMovie: options.searchNow },
        },
      });
      if (!response.monitored) throw new Error('Failed to update existing movie in Radarr');
      if (options.searchNow) await this.searchMovie(response.id);
      return response;
    }

    if (movie.id) {
      if (options.searchNow && !movie.hasFile) await this.searchMovie(movie.id);
      return movie;
    }

    const response = await this.request('POST', '/movie', {
      body: {
        title: options.title,
        qualityProfileId: options.qualityProfileId,
        profileId: options.profileId,
        titleSlug: options.tmdbId.toString(),
        minimumAvailability: options.minimumAvailability,
        tmdbId: options.tmdbId,
        year: options.year,
        rootFolderPath: options.rootFolderPath,
        monitored: options.monitored,
        tags: options.tags,
        addOptions: { searchForMovie: options.searchNow },
      },
    });
    if (!response.id) throw new Error('Failed to add movie to Radarr');
    return response;
  }

  // Seerr does not wait for this call and logs an error. The test waits, so it can read the command.
  async searchMovie(movieId: number) {
    return this.runCommand('MoviesSearch', { movieIds: [movieId] }).catch(() => undefined);
  }

  async removeMovie(tmdbId: number) {
    const { id } = await this.getMovieByTmdbId(tmdbId);
    await this.request('DELETE', `/movie/${id}`, { params: { deleteFiles: true, addImportExclusion: false } });
  }
}

export type AddSeriesOptions = { tvdbid: number; title: string; profileId: number; languageProfileId?: number; seasons: number[]; seasonFolder: boolean; rootFolderPath: string; tags?: number[]; seriesType: string; monitored?: boolean; monitorNewItems?: string; searchNow?: boolean };

export class FakeSonarr extends Servarr {
  getSeries = () => this.request('GET', '/series');
  getLibrarySeriesByTvdbId = (tvdbId: number) => this.request('GET', '/series', { params: { tvdbId } });
  getSeriesById = (id: number) => this.request('GET', `/series/${id}`);
  getEpisodes = (seriesId: number) => this.request('GET', '/episode', { params: { seriesId } });
  monitorEpisodes = (episodeIds: number[]) => this.request('PUT', '/episode/monitor', { body: { episodeIds, monitored: true } });
  getLanguageProfiles = () => this.request('GET', '/languageprofile');

  async getSeriesByTvdbId(id: number) {
    const data = await this.request('GET', '/series/lookup', { params: { term: `tvdb:${id}` } });
    if (!data[0]) throw new Error('Series not found');
    return data[0];
  }

  // The lookup by title. Seerr uses it for the search by name in its request window.
  getSeriesByTitle = (title: string) => this.request('GET', '/series/lookup', { params: { term: title } });

  private buildSeasonList(seasons: number[], existing: any[]) {
    return existing.map((season) => {
      if (seasons.includes(season.seasonNumber)) season.monitored = true;
      return season;
    });
  }

  // sonarr.ts, addSeries. An existing series is updated. A new series is created with all seasons off, then the requested ones on.
  async addSeries(options: AddSeriesOptions) {
    const series = await this.getSeriesByTvdbId(options.tvdbid);

    if (series.id) {
      series.monitored = options.monitored ?? series.monitored;
      series.tags = options.tags ? Array.from(new Set([...series.tags, ...options.tags])) : series.tags;
      series.seasons = this.buildSeasonList(options.seasons, series.seasons);
      const updated = await this.request('PUT', '/series', { body: series });
      if (!updated.id) throw new Error('Failed to update series in Sonarr');

      const episodes: any[] = await this.getEpisodes(updated.id);
      const toMonitor = episodes.filter((episode) => options.seasons.includes(episode.seasonNumber) && !episode.monitored).map((episode) => episode.id);
      if (toMonitor.length > 0) await this.monitorEpisodes(toMonitor);
      if (options.searchNow) await this.searchSeries(updated.id);
      return updated;
    }

    const created = await this.request('POST', '/series', {
      body: {
        tvdbId: options.tvdbid,
        title: options.title,
        qualityProfileId: options.profileId,
        languageProfileId: options.languageProfileId,
        seasons: this.buildSeasonList(
          options.seasons,
          series.seasons.map((season: any) => ({ seasonNumber: season.seasonNumber, monitored: false })),
        ),
        tags: options.tags,
        seasonFolder: options.seasonFolder,
        monitored: options.monitored,
        monitorNewItems: options.monitorNewItems,
        rootFolderPath: options.rootFolderPath,
        seriesType: options.seriesType,
        addOptions: { ignoreEpisodesWithFiles: true, searchForMissingEpisodes: options.searchNow },
      },
    });
    if (!created.id) throw new Error('Failed to add series to Sonarr');
    return created;
  }

  async searchSeries(seriesId: number) {
    return this.runCommand('MissingEpisodeSearch', { seriesId }).catch(() => undefined);
  }

  async removeSeries(tvdbId: number) {
    const { id } = await this.getSeriesByTvdbId(tvdbId);
    await this.request('DELETE', `/series/${id}`, { params: { deleteFiles: true, addImportExclusion: false } });
  }
}
