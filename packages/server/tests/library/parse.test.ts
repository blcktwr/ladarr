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
