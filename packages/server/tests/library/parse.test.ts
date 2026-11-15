import { describe, expect, it } from 'vitest';
import { isSample, isVideoFile, parseEpisodes, titleNumbers } from '../../src/library/parse.ts';
import { episode } from '../helpers/test-fixtures.ts';

describe('episode names', () => {
  it.each([
    ['Show.Name.S01E02.1080p.WEB-DL.mkv', 1, [2]],
    ['Show Name - S01E02 - Title.mkv', 1, [2]],
    ['show.name.s10e105.mkv', 10, [105]],
    ['Show Name S01E02E03.mkv', 1, [2, 3]],
    ['Show Name S01E02-E04.mkv', 1, [2, 3, 4]],
    ['Show Name S01E02-04.mkv', 1, [2, 3, 4]],
    ['Show Name S01E01E02E03.mkv', 1, [1, 2, 3]],
    ['Show Name 1x02.mkv', 1, [2]],
    ['Show Name 2x05-06.mkv', 2, [5, 6]],
    ['S00E01 Special.mkv', 0, [1]],
  ])('reads %s', (name, season, numbers) => {
    expect(parseEpisodes(name)).toEqual({ season, numbers });
  });

  it.each(['Movie.Name.2020.1080p.mkv', 'Show Name 2020-01-05.mkv', 'random.mkv', 'Show 1080x1920.mkv', 'x264 720p.mkv'])('does not read %s', (name) => {
    expect(parseEpisodes(name)).toBeUndefined();
  });

  it('does not expand a huge range', () => {
    expect(parseEpisodes('Show S01E01-E999.mkv')).toEqual({ season: 1, numbers: [1, 999] });
  });

  it('takes the season of the caller when the name has none', () => {
    expect(parseEpisodes('Berserk E01.mkv', 2)).toEqual({ season: 2, numbers: [1] });
    expect(parseEpisodes('Berserk 01.mkv', 2)).toEqual({ season: 2, numbers: [1] });
    // A name with a season of its own keeps it.
    expect(parseEpisodes('Season 3/Berserk E01.mkv', 2)).toEqual({ season: 3, numbers: [1] });
  });
});

describe('episode markers without a season', () => {
  it.each([
    ['Berserk E01.mkv', 1, [1]], // a bare E marker gives season 1
    ['Berserk E12.mkv', 1, [12]], // a two-digit episode is read whole
    ['Show Ep.03 - Title.mkv', 1, [3]], // the Ep. form, with a title after it
    ['Show Ep05.mkv', 1, [5]], // the Ep form, without a dot
    ['Show Episode 01.mkv', 1, [1]], // the word Episode, with a space
    ['Show Cap 01.mkv', 1, [1]], // the Cap form
    ['Show Capitulo 01.mkv', 1, [1]], // the Spanish Capitulo form
    ['Show Capítulo 1.mkv', 1, [1]], // the accented Capitulo, with one digit
    ['Show E01E02.mkv', 1, [1, 2]], // more episodes after the first marker
    ['Show E01-E02.mkv', 1, [1, 2]], // a range with E on both ends
    ['Show E01-02.mkv', 1, [1, 2]], // a range with E only on the first
    ['Show E01-E04.mkv', 1, [1, 2, 3, 4]], // a range expands like SxxExx
    ['Season 3/Show S01E02.mkv', 1, [2]], // the season of the name wins over the folder
  ])('reads %s as season 1', (name, season, numbers) => {
    expect(parseEpisodes(name)).toEqual({ season, numbers });
  });
});

describe('season from a folder or a prefix', () => {
  it.each([
    ['Season 02/Berserk E01.mkv', 2, [1]], // a Season folder with a padded number
    ['Season 3/AoT E04.mkv', 3, [4]], // a Season folder with one digit
    ['AoT - Season 3/AoT E04.mkv', 3, [4]], // the token can sit inside a longer folder name
    ['Temporada 2/Show Cap 5.mkv', 2, [5]], // the Spanish Temporada form
    ['Saison 2/Show Ep02.mkv', 2, [2]], // the French Saison form
    ['Staffel 2/Show E03.mkv', 2, [3]], // the German Staffel form
    ['Stagione 3/Show E04.mkv', 3, [4]], // the Italian Stagione form
    ['S03/Show E05.mkv', 3, [5]], // a short S03 folder
    ['s3/Show E06.mkv', 3, [6]], // a lower-case short season folder
  ])('reads %s as season %s', (name, season, numbers) => {
    expect(parseEpisodes(name)).toEqual({ season, numbers });
  });
});

describe('bare episode numbers', () => {
  it.each([
    ['Season 3/AoT - 04.mkv', 3, [4]], // a bare number is the episode when a season is known
    ['Season 1/Berserk 01.mkv', 1, [1]], // a padded bare number is read as its value
    ['Season 3/AoT - 04 [1080p].mkv', 3, [4]], // brackets are not part of the stem
    ['Season 2/Show 7.mkv', 2, [7]], // one digit is enough
    ['Season 2/Show 105.mkv', 2, [105]], // three digits still count
  ])('reads %s as season %s', (name, season, numbers) => {
    expect(parseEpisodes(name)).toEqual({ season, numbers });
  });
});

describe('numbers that are not an episode', () => {
  it.each([
    ['Season 1/Show 04 1080p.mkv'], // the number is not the last token
    ['Season 1/Show 2016.mkv'], // four digits is a year, not an episode
    ['Berserk 04.mkv'], // a bare number without a season token
    ['Season 1/Show 1080p.mkv'], // 1080p is a resolution
    ['Season 1/Show 720p.mkv'], // 720p is a resolution
    ['Season 1/Show 480p.mkv'], // 480p is a resolution
    ['Season 1/Show 2160p.mkv'], // 2160p is a resolution
    ['Season 1/Show AAC 2.0.mkv'], // 2.0 is part of a quality tag
    ['Season 1/Show DD+ 5.1.mkv'], // 5.1 is part of a quality tag
    ['Season 1/Show x264.mkv'], // x264 is a codec, not an episode
    ['Berserk 2016 S01 1080p BluRay AAC 2.0 x264-GosU.mkv'], // a release name is not a file name
  ])('does not read an episode from %s', (name) => {
    expect(parseEpisodes(name)).toBeUndefined();
  });

  it('keeps the E marker ahead of a bare number', () => {
    expect(parseEpisodes('Season 1/Berserk E01.mkv')).toEqual({ season: 1, numbers: [1] });
  });
});

describe('the Season 01 Berserk torrent', () => {
  it('reads the twelve files of the torrent', () => {
    for (let number = 1; number <= 12; number++) {
      const file = `Berserk E${String(number).padStart(2, '0')}.mkv`;
      expect(parseEpisodes(file)).toEqual({ season: 1, numbers: [number] });
      expect(parseEpisodes(`Season 01/${file}`)).toEqual({ season: 1, numbers: [number] });
    }
  });
});

describe('title numbers', () => {
  const season = (season: number, first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => episode(season, first + i));

  it('maps a relative number to the episode at that position', () => {
    const episodes = season(2, 33, 53);
    expect(titleNumbers(parseEpisodes('Show.S02E01.mkv')!, episodes)).toEqual([33]);
    expect(titleNumbers(parseEpisodes('Show.S02E02.mkv')!, episodes)).toEqual([34]);
    expect(titleNumbers(parseEpisodes('Show.S02E21.mkv')!, episodes)).toEqual([53]);
  });

  it('keeps the numbers of a season that starts at 1', () => {
    const episodes = season(1, 1, 3);
    expect(titleNumbers(parseEpisodes('Show.S01E02.mkv')!, episodes)).toEqual([2]);
  });

  it('keeps a number that is already a title number', () => {
    expect(titleNumbers(parseEpisodes('Show.S02E42.mkv')!, season(2, 33, 53))).toEqual([42]);
  });

  it('drops a number that is neither an episode nor a position', () => {
    expect(titleNumbers(parseEpisodes('Show.S02E99.mkv')!, season(2, 33, 53))).toEqual([]);
  });

  it('keeps a number that is already an episode of the season', () => {
    const episodes = season(2, 5, 25);
    expect(titleNumbers(parseEpisodes('Show.S02E10.mkv')!, episodes)).toEqual([10]);
  });
});

describe('video files and samples', () => {
  it('knows the video extensions', () => {
    expect(['a.mkv', 'a.MP4', 'a.avi'].every(isVideoFile)).toBe(true);
    expect(['a.srt', 'a.nfo', 'a.mkv.part', 'mkv'].some(isVideoFile)).toBe(false);
  });

  it('finds a sample by its name or its folder', () => {
    expect(isSample('Movie.2020-sample.mkv')).toBe(true);
    expect(isSample('Sample/movie.mkv')).toBe(true);
    expect(isSample('Movie.Sampler.mkv')).toBe(false);
    expect(isSample('Movie (2020).mkv')).toBe(false);
  });
});
