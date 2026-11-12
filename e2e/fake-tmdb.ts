import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A small TMDB for tests. It knows one movie and one series, and it speaks the part of API v3 that ladarr uses.
// The benchmark also asks for movies 900001 to 900026. Each one is a movie with a name from this list.
const MOVIE = { id: 2, title: 'Movie Name', original_title: 'Movie Name', release_date: '2019-06-01', overview: 'A movie for the end-to-end tests.', original_language: 'en', poster_path: null };
const SERIES = { id: 1, name: 'Show Name', original_name: 'Show Name', first_air_date: '2020-01-01', overview: 'A series for the end-to-end tests.', original_language: 'en', poster_path: null };
const TWO_SEASONS = { id: 3, name: 'Two Seasons', original_name: 'Two Seasons', first_air_date: '2021-01-01', overview: 'A series with two seasons for the end-to-end tests.', original_language: 'en', poster_path: null };
export const BENCH_MOVIE_ID = 900_000;
export const BENCH_NAMES = 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey Xray Yankee Zulu'.split(' ');
const benchMovie = (id: number) => {
  const name = BENCH_NAMES[id - BENCH_MOVIE_ID - 1];
  return name ? { ...MOVIE, id, title: `Bench Movie ${name}`, original_title: `Bench Movie ${name}` } : undefined;
};
const EPISODES = [1, 2, 3].map((number) => ({ id: 100 + number, episode_number: number, name: `Episode ${number}`, air_date: `2020-01-0${number}`, runtime: 45 }));
const TWO_SEASONS_EPISODES = {
  1: [1, 2].map((number) => ({ id: 300 + number, episode_number: number, name: `Season one episode ${number}`, air_date: `2021-01-0${number}`, runtime: 45 })),
  // Season 2 starts at episode 3, so its numbers are not the positions of the episodes in the season.
  2: [3, 4].map((number, index) => ({ id: 401 + index, episode_number: number, name: `Season two episode ${index + 1}`, air_date: `2021-02-0${index + 1}`, runtime: 45 })),
};

export async function startFakeTmdb() {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    requests.push(url.pathname);
    const send = (body: unknown, status = 200) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const path = url.pathname;
    if (path === '/configuration') return send({});
    if (path === '/search/multi') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      return send({
        results: [
          ...(MOVIE.title.toLowerCase().includes(query) ? [{ ...MOVIE, media_type: 'movie' }] : []),
          ...(SERIES.name.toLowerCase().includes(query) ? [{ ...SERIES, media_type: 'tv' }] : []),
          ...(TWO_SEASONS.name.toLowerCase().includes(query) ? [{ ...TWO_SEASONS, media_type: 'tv' }] : []),
        ],
      });
    }
    // The discovery page. The movie list has a second page, and the rating has another movie first.
    if (path === '/discover/movie') {
      const page = url.searchParams.get('page') ?? '1';
      const topRated = url.searchParams.get('sort_by') === 'vote_average.desc';
      return send({
        page: Number(page),
        total_pages: 2,
        results: page === '2' ? [benchMovie(BENCH_MOVIE_ID + 1)] : topRated ? [MOVIE, benchMovie(BENCH_MOVIE_ID + 2)] : [MOVIE],
      });
    }
    if (path === '/discover/tv') return send({ page: 1, total_pages: 1, results: [SERIES] });
    if (path === '/movie/2/credits') return send({ cast: [{ id: 11, name: 'Actor One', character: 'Role One', profile_path: null }, { id: 12, name: 'Actor Two', character: 'Role Two', profile_path: null }] });
    // The series has no cast, so its page has no cast section.
    if (path === '/tv/1/credits') return send({ cast: [] });
    if (path === '/tv/3/credits') return send({ cast: [] });
    if (path === '/tv/3/recommendations') return send({ results: [] });
    if (path === '/person/11') return send({ id: 11, name: 'Actor One', also_known_as: ['Actor 1', 'Primer Actor'], popularity: 12.34, combined_credits: { cast: [{ ...MOVIE, media_type: 'movie' }, { ...SERIES, media_type: 'tv' }] } });
    if (path === '/movie/2/recommendations') return send({ results: [{ ...benchMovie(BENCH_MOVIE_ID + 1), media_type: 'movie' }] });
    if (path === '/tv/1/recommendations') return send({ results: [] });
    const id = Number(/^\/movie\/(\d+)$/.exec(path)?.[1]);
    const movie = id === 2 ? MOVIE : benchMovie(id);
    if (movie) {
      return send({ ...movie, status: 'Released', runtime: 100, vote_count: id === 2 ? 10 : 0, vote_average: 7.5, external_ids: { imdb_id: 'tt0000002' }, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2019-06-01T00:00:00.000Z' }] }] } });
    }
    if (path === '/tv/1') {
      return send({ ...SERIES, status: 'Returning Series', episode_run_time: [45], vote_count: 10, vote_average: 8.1, external_ids: { tvdb_id: 55, imdb_id: 'tt0000001' }, seasons: [{ season_number: 1, episode_count: EPISODES.length, air_date: '2020-01-01' }] });
    }
    if (path === '/tv/1/season/1') return send({ episodes: EPISODES });
    if (path === '/tv/3') {
      return send({ ...TWO_SEASONS, status: 'Ended', episode_run_time: [45], vote_count: 0, vote_average: 0, external_ids: {}, seasons: [1, 2].map((season) => ({ season_number: season, episode_count: TWO_SEASONS_EPISODES[season as 1 | 2].length, air_date: '2021-01-01' })) });
    }
    if (path === '/tv/3/season/1') return send({ episodes: TWO_SEASONS_EPISODES[1] });
    if (path === '/tv/3/season/2') return send({ episodes: TWO_SEASONS_EPISODES[2] });
    if (path === '/find/55') return send({ tv_results: [{ ...SERIES }] });
    send({ status_message: 'Not found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
