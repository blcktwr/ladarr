import { describe, expect, it } from 'vitest';
import { bestOf, decide, explainDecision, topRejections } from '../../src/library/grab/decide.ts';
import { defaultProfiles, defaultSizes, unlimitedSizes } from '../../src/library/grab/quality.ts';
import { episode, indexer, movie, NOW, release, title } from '../helpers/test-fixtures.ts';
import { emptyData } from '../../src/core/db.ts';
import type { DecideContext, Profile, Want } from '../../src/types.ts';
import type { Numbering } from '@ladarr/shared/types';

const settings = { ...emptyData().settings };
const ctx = (extra: Partial<DecideContext> = {}): DecideContext => ({
  settings,
  quality: emptyData(),
  indexers: { 1: indexer() },
  downloading: () => false,
  hasFile: (e) => Boolean(e.fileId),
  hasMovieFile: (t) => Boolean(t.fileId),
  coverage: () => null,
  now: NOW,
  ...extra,
});

const show = title({ episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
const ep2: Want = { kind: 'episode', title: show, season: 1, number: 2 };
const season1: Want = { kind: 'season', title: show, season: 1 };
const film: Want = { kind: 'movie', title: movie() };
const filmSize = 100 * 1024 * 1024 * 60;

const codes = (name: string, want: Want, extra: Partial<DecideContext> = {}, release2 = {}) => decide(release(name, release2), want, ctx(extra)).rejections;

describe('identity', () => {
  it('accepts the right episode', () => {
    const d = decide(release('Show.Name.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRP'), ep2, ctx());
    expect(d).toMatchObject({ accepted: true, kind: 'single', covers: [{ season: 1, number: 2 }] });
  });

  it.each([
    ['Other.Show.S01E02.1080p.WEB-DL-GRP', ['wrong_title']],
    ['Show.Name.S02E02.1080p.WEB-DL-GRP', ['wrong_season']],
    ['Show.Name.S01E03.1080p.WEB-DL-GRP', ['wrong_episode']],
    ['Show.Name.1080p.WEB-DL-GRP', ['not_an_episode']],
    ['Show.Name.S01.1080p.WEB-DL-GRP', ['not_an_episode']],
    ['Show.Name.S01-S03.1080p.WEB-DL-GRP', ['multi_season_pack']],
  ])('rejects %s', (name, expected) => {
    expect(codes(name, ep2)).toEqual(expected);
  });

  it('takes a multi-episode file only when ladarr has none of the other episodes', () => {
    expect(decide(release('Show.Name.S01E02E03.1080p.WEB-DL-GRP', { sizeBytes: 120 * 45 * 1024 * 1024 }), ep2, ctx())).toMatchObject({ accepted: true, kind: 'multi' });
    const withFile = title({ episodes: [episode(1, 1), episode(1, 2), episode(1, 3, '2020-01-01', { fileId: 'f' })] });
    expect(codes('Show.Name.S01E02E03.1080p.WEB-DL-GRP', { ...ep2, title: withFile })).toContain('covers_available_episode');
  });

  it('matches a daily release only when one episode aired that day', () => {
    const daily = title({ episodes: [episode(2024, 75, '2024-03-15'), episode(2024, 76, '2024-03-16'), episode(2024, 77, '2024-03-16')] });
    expect(codes('Show.Name.2024.03.15.1080p.WEB-DL-GRP', { kind: 'episode', title: daily, season: 2024, number: 75 })).toEqual([]);
    expect(codes('Show.Name.2024.03.16.1080p.WEB-DL-GRP', { kind: 'episode', title: daily, season: 2024, number: 76 })).toEqual(['daily_ambiguous']);
    expect(codes('Show.Name.2024.03.20.1080p.WEB-DL-GRP', { kind: 'episode', title: daily, season: 2024, number: 76 })).toEqual(['daily_ambiguous']);
  });

  it('rejects a movie when the year is missing or wrong, instead of guessing', () => {
    const size = { sizeBytes: filmSize };
    expect(codes('Movie.Name.2019.1080p.BluRay-GRP', film, {}, { sizeBytes: 100 * 120 * 1024 * 1024 })).toEqual([]);
    expect(codes('Movie.Name.1080p.BluRay-GRP', film, {}, size)).toContain('year_missing');
    expect(codes('Movie.Name.2018.1080p.BluRay-GRP', film, {}, size)).toContain('year_mismatch');
    expect(codes('Movie.Name.S01E01.2019.1080p.BluRay-GRP', film, {}, size)).toContain('not_a_movie');
  });

  it('rejects the year of another title with the same name', () => {
    expect(codes('Show.Name.1963.S01E02.1080p.WEB-DL-GRP', ep2)).toEqual(['year_mismatch']);
    expect(codes('Show.Name.2020.S01E02.1080p.WEB-DL-GRP', ep2)).toEqual([]);
    // A later year can be the year of a season, so it does not rule the release out.
    expect(codes('Show.Name.2021.S01E02.1080p.WEB-DL-GRP', ep2)).toEqual([]);
  });

  it.each([2019, null])('rejects an absolute-numbered episode for a movie with year %s', (year) => {
    const target = movie({ meta: { ...movie().meta, year } });
    expect(codes('[Group] Movie Name 2019 - 01 [1080p][WEB-DL]', { kind: 'movie', title: target })).toEqual(['not_a_movie']);
  });

  it('does not guess the year of a title that the catalog does not give', () => {
    const unknown = movie({ meta: { ...movie().meta, year: null } });
    expect(codes('Movie.Name.2019.1080p.BluRay-GRP', { kind: 'movie', title: unknown }, {}, { sizeBytes: filmSize })).toEqual([]);
    expect(codes('Movie.Name.1080p.BluRay-GRP', { kind: 'movie', title: unknown }, {}, { sizeBytes: filmSize })).toEqual([]);
  });

  it('matches a release of an anime by its absolute number', () => {
    const anime = title({ episodes: show.episodes, seriesType: 'anime', meta: { ...show.meta, title: 'Anime Name', originalTitle: 'Anime Name' } });
    const want: Want = { kind: 'episode', title: anime, season: 1, number: 3 };
    expect(codes('[SubsPlease] Anime Name - 03 [1080p][WEB-DL]', want)).toEqual([]);
    expect(codes('[SubsPlease] Anime Name - 05 [1080p][WEB-DL]', want)).toEqual(['wrong_episode']);
  });

  it('matches an alias of the title', () => {
    const aliased = title({ episodes: [episode(1, 1)], meta: { ...show.meta, aliases: ['Le Show'] } });
    expect(codes('Le.Show.S01E01.1080p.WEB-DL-GRP', { kind: 'episode', title: aliased, season: 1, number: 1 })).toEqual([]);
  });

  it('does not match an absolute number to a special', () => {
    const anime = title({ seriesType: 'anime', episodes: [episode(0, 1), episode(0, 2), episode(1, 1)] });
    const name = '[Group] Show Name - 01 [1080p][WEB-DL]';
    expect(codes(name, { kind: 'episode', title: anime, season: 0, number: 2 })).toEqual(['wrong_episode']);
    expect(decide(release(name), { kind: 'episode', title: anime, season: 1, number: 1 }, ctx())).toMatchObject({
      accepted: true,
      covers: [{ season: 1, number: 1 }],
    });
  });
});

describe('packs', () => {
  it('accepts a season pack when every aired episode is wanted', () => {
    const d = decide(release('Show.Name.S01.1080p.WEB-DL-GRP', { sizeBytes: 3 * 60 * 45 * 1024 * 1024 }), season1, ctx());
    expect(d).toMatchObject({ accepted: true, kind: 'pack' });
    expect(d.covers).toHaveLength(3);
  });

  it('accepts a pack that the library has in part or in full', () => {
    const size = { sizeBytes: 3 * 60 * 45 * 1024 * 1024 };
    // One episode has a file. The import takes the files of the other two and skips the one that the library has.
    const has = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f' }), episode(1, 2), episode(1, 3)] });
    expect(codes('Show.Name.S01.1080p.WEB-DL-GRP', { ...season1, title: has }, {}, size)).toEqual([]);
    // Every aired episode has a file, so the import skips every file of the pack.
    const all = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f' }), episode(1, 2, '2020-01-02', { fileId: 'f' }), episode(1, 3, '2020-01-03', { fileId: 'f' })] });
    expect(codes('Show.Name.S01.1080p.WEB-DL-GRP', { ...season1, title: all }, {}, size)).toEqual([]);
    // An episode that the user did not ask for does not stop the pack.
    const off = title({ episodes: [episode(1, 1, '2020-01-01', { override: 'unmonitored' }), episode(1, 2)] });
    expect(codes('Show.Name.S01.1080p.WEB-DL-GRP', { ...season1, title: off }, {}, { sizeBytes: 2 * 60 * 45 * 1024 * 1024 })).toEqual([]);
  });

  it('lets a manual choice take any release, also one of another title', () => {
    const has = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f' }), episode(1, 2)] });
    expect(codes('Show.Name.S01.1080p.WEB-DL-GRP', { ...season1, title: has }, { manual: true })).toEqual([]);
    expect(codes('Other.S01.1080p.WEB-DL-GRP', { ...season1, title: has }, { manual: true })).toEqual([]);
  });

  it('accepts only a pack for a season want', () => {
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', season1)).toContain('not_a_pack');
  });

  it('rejects a pack that holds only a part of the season', () => {
    expect(codes('Show.Name.S01.Part.1.1080p.WEB-DL-GRP', season1)).toEqual(['not_a_pack']);
    expect(codes('Show.Name.S01.Part.1.1080p.WEB-DL-GRP', ep2)).toEqual(['not_an_episode']);
  });

  it('rejects a list of several seasons', () => {
    expect(codes('Show.Name.S01.S02.1080p.WEB-DL-GRP', season1)).toEqual(['multi_season_pack']);
  });

  it('rejects a pack that a daily name gives for a single episode', () => {
    const daily = title({ episodes: [episode(2024, 75, '2024-03-15')] });
    expect(codes('Show.Name.S01.2024.03.15.1080p.WEB-DL-GRP', { kind: 'episode', title: daily, season: 2024, number: 75 })).toEqual(['not_an_episode']);
  });

  it('checks the size and preferred distance against the known coverage of a pack', () => {
    const quality = emptyData();
    quality.qualitySizes.tv['webdl-1080'] = { min: 12.5, preferred: 60, max: 100 };
    const context = ctx({ quality, coverage: () => ({ titleKey: show.key, season: 1, numbers: [2], numberingRevision: 0 }) });
    const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
    expect(decide(release(name), season1, context)).toMatchObject({ accepted: true, mibPerMinute: 60, distance: 0 });
    expect(decide(release(name, { sizeBytes: 120 * 45 * 1024 * 1024 }), season1, context)).toMatchObject({
      accepted: false,
      rejections: ['size_above_max'],
      mibPerMinute: 120,
    });
  });
});

describe('a season that the releases count as two', () => {
  const MIB = 1024 * 1024;
  // TMDB counts 23 episodes in season 1. The releases count the last ten as season 2, which TMDB does not have.
  const split = title({ episodes: Array.from({ length: 23 }, (_, index) => episode(1, index + 1, '2020-01-01')) });
  const rest = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  // The last ten episodes of TMDB season 1 are release season 2, from its first episode.
  const numbering: Numbering = { revision: 1, ranges: [{ season: 1, from: 14, to: 23, releaseSeason: 2, releaseFrom: 1 }] };
  const restEpisode: Want = { kind: 'episode', title: split, season: 1, number: 14, numbering };
  const restSeason: Want = { kind: 'season', title: split, season: 1, releaseSeason: 2, numbering };
  const restPack = () => release('Show.Name.S02.1080p.WEB-DL-GRP', { sizeBytes: 10 * 600 * MIB });

  it('reads the number of the release as a place in the rest of the season', () => {
    expect(codes('Show.Name.S02E01.1080p.WEB-DL-GRP', restEpisode)).toEqual([]);
    expect(codes('Show.Name.S02E02.1080p.WEB-DL-GRP', restEpisode)).toEqual(['wrong_episode']);
    // An episode outside the range keeps the numbering of the title.
    expect(codes('Show.Name.S01E13.1080p.WEB-DL-GRP', { ...restEpisode, number: 13 })).toEqual([]);
    // The range gives 1x14 to release 2x01, so a release of season 1 cannot claim that target too.
    expect(codes('Show.Name.S01E14.1080p.WEB-DL-GRP', restEpisode)).toEqual(['wrong_episode']);
    expect(codes('Show.Name.S01E01.1080p.WEB-DL-GRP', restEpisode)).toEqual(['wrong_episode']);
  });

  it('takes the pack of the next season for the rest of the season', () => {
    const decision = decide(restPack(), restSeason, ctx());
    expect(decision).toMatchObject({ accepted: true, kind: 'pack' });
    expect(decision.covers).toEqual(rest.map((number) => ({ season: 1, number })));
  });

  it('checks the size of a mapped pack against only the remaining episodes', () => {
    const quality = emptyData();
    quality.qualitySizes.tv['webdl-1080'] = { min: 12.5, preferred: 60, max: 100 };
    const decision = decide(release('Show.Name.S02.1080p.WEB-DL-GRP', { sizeBytes: 10 * 120 * 45 * MIB }), restSeason, ctx({ quality }));
    expect(decision).toMatchObject({ accepted: false, rejections: ['size_above_max'], mibPerMinute: 120, distance: 60 });
  });

  it('takes no pack of another season without the numbering of the release', () => {
    expect(codes('Show.Name.S02.1080p.WEB-DL-GRP', { kind: 'season', title: split, season: 1 })).toEqual(['wrong_season']);
  });

  it('takes only the episodes that an earlier download of the pack held', () => {
    const held = (numbers: number[], revision = numbering.revision) => ctx({ coverage: () => ({ titleKey: 'tv:1', season: 1, numbers, numberingRevision: revision }) });
    expect(decide(restPack(), restSeason, held(rest)).covers).toEqual(rest.map((number) => ({ season: 1, number })));
    // The pack held the first part of the season, so it holds nothing of the rest: the search does not take it again.
    const first = decide(restPack(), restSeason, held([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
    expect(first.covers).toEqual([]);
    expect(first.rejections).toContain('pack_covers_others');
    // A pack of the season that held a part of it covers that part only.
    const part = decide(release('Show.Name.S01.1080p.WEB-DL-GRP'), season1, held([1, 2], 0));
    expect(part).toMatchObject({ accepted: true, kind: 'pack', covers: [{ season: 1, number: 1 }, { season: 1, number: 2 }] });
  });

  it('accepts a pack that is too small for the whole season and large enough for a part of it', () => {
    // 13 of the 23 episodes at 600 MiB each: below the minimum of the quality for 23 episodes of 45 minutes.
    const size = { sizeBytes: 13 * 600 * MIB };
    expect(codes('Show.Name.S01.1080p.WEB-DL-GRP', { kind: 'season', title: split, season: 1 }, {}, size)).toEqual([]);
    // An episode still checks its own size.
    expect(codes('Show.Name.S01E01.1080p.WEB-DL-GRP', { kind: 'episode', title: split, season: 1, number: 1 }, {}, { sizeBytes: 10 * MIB })).toEqual(['size_below_min']);
  });
});

describe('policy', () => {
  it('applies the preset: quality, size, and audio', () => {
    expect(codes('Show.Name.S01E02.CAM-GRP', ep2)).toContain('quality_rejected');
    expect(codes('Show.Name.S01E02.720p.WEB-DL-GRP', ep2)).toContain('quality_not_in_profile');
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, {}, { sizeBytes: 10 * 1024 * 1024 })).toContain('size_below_min');
    const capped = { quality: { ...emptyData(), qualitySizes: { movie: unlimitedSizes(), tv: { ...defaultSizes(), 'webdl-1080': { min: 12.5, preferred: null, max: 150 } } } } };
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, capped, { sizeBytes: 90_000 * 1024 * 1024 })).toContain('size_above_max');
    const strict = { settings: { ...settings, audio: { language: 'es', strict: true } } };
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, strict)).toContain('audio_unverified');
    expect(codes('Show.Name.S01E02.GERMAN.1080p.WEB-DL-GRP', ep2, strict)).toContain('audio_language_missing');
  });

  it('uses the table of movies for a movie and the table of series for an episode', () => {
    // The same 10 MiB file is 0.1 MiB per minute of the 100 minutes of the movie, and about 0.2 MiB per minute of the
    // 45 minutes of the episode. The table of movies has no minimum, so only the episode is too small.
    const size = { sizeBytes: 10 * 1024 * 1024 };
    expect(codes('Movie.Name.2019.1080p.WEB-DL-GRP', film, {}, size)).toEqual([]);
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, {}, size)).toEqual(['size_below_min']);
  });

  it('rejects a release in the queue and a target that has a file', () => {
    const name = 'Show.Name.S01E02.1080p.WEB-DL-GRP';
    const hash = 'a'.repeat(40);
    expect(codes(name, ep2, { downloading: (h) => h === hash }, { infoHash: hash })).toEqual(['already_downloading']);
    const has = title({ episodes: [episode(1, 2, '2020-01-01', { fileId: 'f' })] });
    expect(codes(name, { ...ep2, title: has })).toEqual(['already_available']);
    expect(codes(name, { ...ep2, title: has }, { manual: true })).toEqual([]);
  });

  it('does not check the size of a release that the indexer gave no size for', () => {
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, {}, { sizeBytes: 0 })).toEqual([]);
  });

  it('uses the hash of the magnet when the answer has no hash', () => {
    const hash = 'b'.repeat(40);
    const magnet = `magnet:?xt=urn:btih:${hash}&dn=Show.Name.S01E02.1080p.WEB-DL-GRP`;
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, { downloading: (h) => h === hash }, { magnet, link: null })).toEqual(['already_downloading']);
  });

  it('does not take a missing episode of the catalog for a file that is available', () => {
    const short = title({ episodes: [episode(1, 1), episode(1, 2)] });
    expect(codes('Show.Name.S01E02E03.1080p.WEB-DL-GRP', { ...ep2, title: short }, {}, { sizeBytes: 120 * 45 * 1024 * 1024 })).toEqual([]);
  });

  it('rejects a release with no link', () => {
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, {}, { link: null })).toEqual(['no_download_link']);
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, { indexers: {} })).toEqual(['indexer_removed']);
  });
});

describe('seeders', () => {
  const name = 'Show.Name.S01E02.1080p.WEB-DL-GRP';
  const on = { indexers: { 1: indexer({ rejectZeroSeeders: true }) } };
  const off = { indexers: { 1: indexer({ rejectZeroSeeders: false }) } };

  it('rejects a release with no seeders when the indexer asks for it', () => {
    expect(codes(name, ep2, on, { seeders: 0 })).toEqual(['no_seeders']);
  });

  it('accepts a release with no seeders when the indexer does not ask for it', () => {
    expect(codes(name, ep2, off, { seeders: 0 })).toEqual([]);
    expect(codes(name, ep2, {}, { seeders: 0 })).toEqual([]);
  });

  it('accepts a release when the indexer does not know its seeders', () => {
    expect(codes(name, ep2, on, { seeders: null })).toEqual([]);
  });

  it('accepts a release with seeders when the indexer asks for it', () => {
    expect(codes(name, ep2, on, { seeders: 5 })).toEqual([]);
  });

  it('lets a manual choice take a release with no seeders', () => {
    expect(codes(name, ep2, { ...on, manual: true }, { seeders: 0 })).toEqual([]);
  });
});

describe('ranking', () => {
  const MIB = 1024 * 1024;
  const pick = (releases: ReturnType<typeof release>[], extra: Partial<DecideContext> = {}) => {
    const list = releases.map((r) => decide(r, ep2, ctx(extra)));
    return bestOf(list)?.release.guid;
  };

  it('prefers WEB-DL over WEBRip over BluRay, then the size closest to the preferred size', () => {
    const bluray = release('Show.Name.S01E02.1080p.BluRay-A', { sizeBytes: 120 * 45 * MIB });
    const webrip = release('Show.Name.S01E02.1080p.WEBRip-B', { sizeBytes: 55 * 45 * MIB });
    const webdlBig = release('Show.Name.S01E02.1080p.WEB-DL-C', { sizeBytes: 140 * 45 * MIB });
    const webdlNear = release('Show.Name.S01E02.1080p.WEB-DL-D', { sizeBytes: 62 * 45 * MIB });
    const near = { quality: { ...emptyData(), qualitySizes: { movie: unlimitedSizes(), tv: { ...defaultSizes(), 'webdl-1080': { min: 12.5, preferred: 60, max: null } } } } };
    expect(pick([bluray, webrip, webdlBig, webdlNear], near)).toBe(webdlNear.guid);
    expect(pick([bluray, webrip])).toBe(webrip.guid);
  });

  it('uses the indexer priority before the size, then seeders, then a stable key', () => {
    const low = indexer({ id: 2 });
    low.push.sonarr!.priority = 40;
    const both = { indexers: { 1: indexer(), 2: low } };
    const a = release('Show.Name.S01E02.1080p.WEB-DL-A', { indexerId: 2, sizeBytes: 60 * 45 * MIB });
    const b = release('Show.Name.S01E02.1080p.WEB-DL-B', { indexerId: 1, sizeBytes: 100 * 45 * MIB });
    expect(pick([a, b], both)).toBe(b.guid);
    const c = release('Show.Name.S01E02.1080p.WEB-DL-C', { seeders: 3 });
    const d = release('Show.Name.S01E02.1080p.WEB-DL-D', { seeders: 30 });
    expect(pick([c, d])).toBe(d.guid);
    const e = release('Show.Name.S01E02.1080p.WEB-DL-E', { seeders: 5 });
    const f = release('Show.Name.S01E02.1080p.WEB-DL-F', { seeders: 5 });
    expect(pick([f, e])).toBe(e.guid);
  });

  it('does not let a quality with no preferred size win the distance alone', () => {
    const sameGroup: Profile = { id: 'p', name: 'p', items: [['webdl-1080', 'webrip-1080']] };
    const quality = { profiles: { p: sameGroup }, profileOrder: ['p'], qualitySizes: { movie: unlimitedSizes(), tv: { ...defaultSizes(), 'webdl-1080': { min: null, preferred: 60, max: null } } } };
    const near = release('Show.Name.S01E02.1080p.WEB-DL-A', { sizeBytes: 61 * 45 * MIB, seeders: 20 });
    const unpreferred = release('Show.Name.S01E02.1080p.WEBRip-B', { sizeBytes: 55 * 45 * MIB, seeders: 5 });
    expect(pick([unpreferred, near], { quality })).toBe(near.guid);
  });

  it('counts the codes that stopped the most releases', () => {
    const list = ['A.CAM', 'B.CAM', 'Show.Name.S01E03.1080p.WEB-DL-X'].map((n) => decide(release(n), ep2, ctx()));
    expect(topRejections(list, 20)).toContain('wrong_title');
    expect(bestOf(list)).toBeUndefined();
  });
});

describe('explanations', () => {
  const detail = (name: string, want: Want, code: string) => {
    const explained = explainDecision(decide(release(name), want, ctx()), { profiles: [defaultProfiles().p1080!], indexer: 'Tracker', year: want.title.meta.year, season: 1, number: 2 });
    return explained.reasons.find((reason) => reason.code === code)?.detail ?? '';
  };

  it('names the quality that the upgrade asks for', () => {
    expect(detail('Show.Name.S01E02.2160p.WEB-DL-GRP', { ...ep2, upgradeQuality: '1080p' }, 'not_an_upgrade')).toContain('1080p');
  });

  it('does not call a release with no season a single episode', () => {
    expect(codes('Show.Name.1080p.WEB-DL-GRP', season1)).toEqual(['not_a_pack']);
    expect(detail('Show.Name.1080p.WEB-DL-GRP', season1, 'not_a_pack')).not.toContain('single episode');
  });

  it('names the air date of a daily release', () => {
    const daily = title({ episodes: [episode(2024, 75, '2024-03-15'), episode(2024, 76, '2024-03-20')] });
    const explained = explainDecision(decide(release('Show.Name.2024.03.15.1080p.WEB-DL-GRP'), { kind: 'episode', title: daily, season: 2024, number: 76 }, ctx()), {
      profiles: [defaultProfiles().p1080!],
      indexer: 'Tracker',
      year: 2024,
      season: 2024,
      number: 76,
    });
    expect(explained.reasons.find((reason) => reason.code === 'wrong_episode')?.detail ?? '').toContain('2024-03-15');
  });
});

describe('a chain of profiles', () => {
  const p1080 = defaultProfiles().p1080!;
  // The 480p profile of the chain takes 480p only.
  const p480: Profile = { id: 'p480', name: '480p', items: [['webdl-480'], ['webrip-480'], ['bluray-480']] };
  const chain = [p1080, p480];
  const chainData = () => ({ profiles: { p1080, p480 }, profileOrder: ['p1080', 'p480'], qualitySizes: { movie: unlimitedSizes(), tv: defaultSizes() } });
  // A title with the preset "3" starts at that profile and uses the profiles below it: p480 here.
  const p720Only: Profile = { id: '3', name: '720p custom', items: [['webdl-720']] };
  const withPreset3 = () => ({ profiles: { p1080, '3': p720Only, p480 }, profileOrder: ['p1080', '3', 'p480'], qualitySizes: { movie: unlimitedSizes(), tv: defaultSizes() } });

  it('accepts a 480p release in the second profile', () => {
    const quality = chainData();
    const decision = decide(release('Show.Name.S01E02.480p.WEB-DL-GRP'), ep2, ctx({ quality }));
    expect(decision.accepted).toBe(true);
    expect(explainDecision(decision, { profiles: chain, indexer: 'Tracker' }).quality).toBe('WEB-DL 480p');
  });

  it('chooses the 1080p release over the 480p release', () => {
    const quality = chainData();
    const high = decide(release('Show.Name.S01E02.1080p.WEB-DL-HIGH'), ep2, ctx({ quality }));
    const low = decide(release('Show.Name.S01E02.480p.WEB-DL-LOW'), ep2, ctx({ quality }));
    expect(bestOf([low, high])?.release.guid).toBe(high.release.guid);
  });

  it('starts a title at its preset and ignores the profiles above it', () => {
    const quality = withPreset3();
    const want: Want = { ...ep2, title: { ...show, preset: '3' } };
    expect(decide(release('Show.Name.S01E02.1080p.WEB-DL-GRP'), want, ctx({ quality })).rejections).toContain('quality_not_in_profile');
    expect(decide(release('Show.Name.S01E02.480p.WEB-DL-GRP'), want, ctx({ quality })).accepted).toBe(true);
  });

  it('lists the qualities of the whole chain when no profile takes the release', () => {
    const quality = chainData();
    const decision = decide(release('Show.Name.S01E02.720p.WEB-DL-GRP'), ep2, ctx({ quality }));
    const explained = explainDecision(decision, { profiles: chain, indexer: 'Tracker', year: 2020 });
    const detail = explained.reasons.find((reason) => reason.code === 'quality_not_in_profile')?.detail ?? '';
    expect(detail).toContain('WEB-DL 1080p');
    expect(detail).toContain('WEB-DL 480p');
  });
});
