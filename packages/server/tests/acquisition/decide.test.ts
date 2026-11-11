import { describe, expect, it } from 'vitest';
import { bestOf, decide, explainDecision, topRejections, type Context, type Want } from '../../src/library/grab/decide.ts';
import { defaultProfiles, defaultSizes, type Profile } from '../../src/library/grab/quality.ts';
import { episode, indexer, movie, NOW, release, title } from '../helpers/test-fixtures.ts';
import { emptyData } from '../../src/core/db.ts';

const settings = { ...emptyData().settings };
const ctx = (extra: Partial<Context> = {}): Context => ({
  settings,
  quality: emptyData(),
  indexers: { 1: indexer() },
  blocked: () => false,
  downloading: () => false,
  hasFile: (e) => Boolean(e.fileId),
  hasMovieFile: (t) => Boolean(t.fileId),
  now: NOW,
  ...extra,
});

const show = title({ episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
const ep2: Want = { kind: 'episode', title: show, season: 1, number: 2 };
const season1: Want = { kind: 'season', title: show, season: 1 };
const film: Want = { kind: 'movie', title: movie() };
const filmSize = 100 * 1024 * 1024 * 60;

const codes = (name: string, want: Want, extra: Partial<Context> = {}, release2 = {}) => decide(release(name, release2), want, ctx(extra)).rejections;

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

  it('matches an alias of the title', () => {
    const aliased = title({ episodes: [episode(1, 1)], meta: { ...show.meta, aliases: ['Le Show'] } });
    expect(codes('Le.Show.S01E01.1080p.WEB-DL-GRP', { kind: 'episode', title: aliased, season: 1, number: 1 })).toEqual([]);
  });
});

describe('packs', () => {
  it('accepts a season pack when every aired episode is wanted', () => {
    const d = decide(release('Show.Name.S01.1080p.WEB-DL-GRP', { sizeBytes: 3 * 60 * 45 * 1024 * 1024 }), season1, ctx());
    expect(d).toMatchObject({ accepted: true, kind: 'pack' });
    expect(d.covers).toHaveLength(3);
  });

  it('rejects a pack that holds an episode that ladarr has, or one that is not monitored', () => {
    const size = { sizeBytes: 3 * 60 * 45 * 1024 * 1024 };
    const has = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f' }), episode(1, 2), episode(1, 3)] });
    expect(codes('Show.Name.S01.1080p.WEB-DL-GRP', { ...season1, title: has }, {}, size)).toEqual(['pack_has_unwanted_episodes']);
    const off = title({ episodes: [episode(1, 1, '2020-01-01', { override: 'unmonitored' }), episode(1, 2)] });
    expect(codes('Show.Name.S01.1080p.WEB-DL-GRP', { ...season1, title: off }, {}, { sizeBytes: 2 * 60 * 45 * 1024 * 1024 })).toEqual(['pack_has_unwanted_episodes']);
  });

  it('lets a manual choice take such a pack, but not skip the identity', () => {
    const has = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f' }), episode(1, 2)] });
    expect(codes('Show.Name.S01.1080p.WEB-DL-GRP', { ...season1, title: has }, { manual: true })).toEqual([]);
    expect(codes('Other.S01.1080p.WEB-DL-GRP', { ...season1, title: has }, { manual: true })).toEqual(['wrong_title']);
  });

  it('accepts only a pack for a season want', () => {
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', season1)).toContain('not_a_pack');
  });
});

describe('policy', () => {
  it('applies the preset: quality, size, and audio', () => {
    expect(codes('Show.Name.S01E02.CAM-GRP', ep2)).toContain('quality_rejected');
    expect(codes('Show.Name.S01E02.720p.WEB-DL-GRP', ep2)).toContain('quality_not_in_profile');
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, {}, { sizeBytes: 10 * 1024 * 1024 })).toContain('size_below_min');
    const capped = { quality: { ...emptyData(), qualitySizes: { ...defaultSizes(), 'webdl-1080': { min: 12.5, preferred: null, max: 150 } } } };
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, capped, { sizeBytes: 90_000 * 1024 * 1024 })).toContain('size_above_max');
    const strict = { settings: { ...settings, audio: { language: 'es', strict: true } } };
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, strict)).toContain('audio_unverified');
    expect(codes('Show.Name.S01E02.GERMAN.1080p.WEB-DL-GRP', ep2, strict)).toContain('audio_language_missing');
  });

  it('rejects a blocked release, a release in the queue, and a target that has a file', () => {
    const name = 'Show.Name.S01E02.1080p.WEB-DL-GRP';
    const hash = 'a'.repeat(40);
    expect(codes(name, ep2, { blocked: () => true })).toEqual(['blocklisted']);
    expect(codes(name, ep2, { downloading: (h) => h === hash }, { infoHash: hash })).toEqual(['already_downloading']);
    const has = title({ episodes: [episode(1, 2, '2020-01-01', { fileId: 'f' })] });
    expect(codes(name, { ...ep2, title: has })).toEqual(['already_available']);
    expect(codes(name, { ...ep2, title: has }, { manual: true })).toEqual([]);
  });

  it('rejects a release with no link', () => {
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, {}, { link: null })).toEqual(['no_download_link']);
    expect(codes('Show.Name.S01E02.1080p.WEB-DL-GRP', ep2, { indexers: {} })).toEqual(['indexer_removed']);
  });
});

describe('ranking', () => {
  const MIB = 1024 * 1024;
  const pick = (releases: ReturnType<typeof release>[], extra: Partial<Context> = {}) => {
    const list = releases.map((r) => decide(r, ep2, ctx(extra)));
    return bestOf(list)?.release.guid;
  };

  it('prefers WEB-DL over WEBRip over BluRay, then the size closest to the preferred size', () => {
    const bluray = release('Show.Name.S01E02.1080p.BluRay-A', { sizeBytes: 120 * 45 * MIB });
    const webrip = release('Show.Name.S01E02.1080p.WEBRip-B', { sizeBytes: 55 * 45 * MIB });
    const webdlBig = release('Show.Name.S01E02.1080p.WEB-DL-C', { sizeBytes: 140 * 45 * MIB });
    const webdlNear = release('Show.Name.S01E02.1080p.WEB-DL-D', { sizeBytes: 62 * 45 * MIB });
    const near = { quality: { ...emptyData(), qualitySizes: { ...defaultSizes(), 'webdl-1080': { min: 12.5, preferred: 60, max: null } } } };
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

  it('counts the codes that stopped the most releases', () => {
    const list = ['A.CAM', 'B.CAM', 'Show.Name.S01E03.1080p.WEB-DL-X'].map((n) => decide(release(n), ep2, ctx()));
    expect(topRejections(list, 20)).toContain('wrong_title');
    expect(bestOf(list)).toBeUndefined();
  });
});

describe('a chain of profiles', () => {
  const p1080 = defaultProfiles().p1080!;
  // The 480p profile of the chain takes 480p only.
  const p480: Profile = { id: 'p480', name: '480p', items: [['webdl-480'], ['webrip-480'], ['bluray-480']] };
  const chain = [p1080, p480];
  const chainData = () => ({ profiles: { p1080, p480 }, profileOrder: ['p1080', 'p480'], qualitySizes: defaultSizes() });
  // A title with the preset "3" starts at that profile and uses the profiles below it: p480 here.
  const p720Only: Profile = { id: '3', name: '720p custom', items: [['webdl-720']] };
  const withPreset3 = () => ({ profiles: { p1080, '3': p720Only, p480 }, profileOrder: ['p1080', '3', 'p480'], qualitySizes: defaultSizes() });

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
