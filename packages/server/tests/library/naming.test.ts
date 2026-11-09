import { describe, expect, it } from 'vitest';
import { DEFAULT_NAMING, episodePath, exampleNames, folderName, moviePath, sanitize, templateProblem } from '../../src/library/naming.ts';
import { parseEpisodes } from '../../src/library/parse.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';

describe('default names', () => {
  it('keeps the names that ladarr always used', () => {
    const show = title();
    const film = movie();
    expect(moviePath(film, 'Movie Name (2019)', '.mkv')).toBe('Movie Name (2019)/Movie Name (2019).mkv');
    expect(episodePath(show, 'Show Name (2020)', [episode(1, 2)], '.mkv')).toBe('Show Name (2020)/Season 01/Show Name - S01E02 - Episode 2.mkv');
    expect(episodePath(show, 'Show Name (2020)', [episode(1, 2), episode(1, 3)], '.mkv')).toBe('Show Name (2020)/Season 01/Show Name - S01E02E03.mkv');
    expect(episodePath(show, 'Show Name (2020)', [episode(0, 1, null, { name: '' })], '.mkv')).toBe('Show Name (2020)/Specials/Show Name - S00E01 - Episode 1.mkv');
  });

  it('leaves out empty brackets when the year is not known', () => {
    const film = movie({ meta: { ...movie().meta, year: null } });
    expect(moviePath(film, folderName(film), '.mkv')).toBe('Movie Name/Movie Name.mkv');
  });

  it('removes what a file system does not allow', () => {
    const film = movie({ meta: { ...movie().meta, title: 'What: If?' } });
    expect(moviePath(film, 'x', '.mkv')).toBe('x/What If (2019).mkv');
    expect(sanitize('  a/b\\c.  ')).toBe('abc');
  });
});

describe('templates', () => {
  it('builds a name from the tokens', () => {
    const show = title();
    const naming = { movie: '{title} [{year}]', episode: '{title} ({year}) S{season}E{episode} {episodeTitle}' };
    expect(moviePath(movie(), 'f', '.mkv', naming)).toBe('f/Movie Name [2019].mkv');
    expect(episodePath(show, 'f', [episode(2, 5)], '.mkv', naming)).toBe('f/Season 02/Show Name (2020) S02E05 Episode 5.mkv');
    // A file for several episodes has no episode title.
    expect(episodePath(show, 'f', [episode(2, 5), episode(2, 6)], '.mkv', naming)).toBe('f/Season 02/Show Name (2020) S02E05E06.mkv');
  });

  it('keeps the season and the episode in a name that is too long', () => {
    const naming = { ...DEFAULT_NAMING, episode: '{title} - {episodeTitle} - S{season}E{episode}' };
    const read = (path: string) => parseEpisodes(path.split('/').pop()!);
    // A long episode title is cut. The season and the episode stay.
    const long = episodePath(title(), 'f', [episode(1, 2, null, { name: 'x'.repeat(200) })], '.mkv', naming);
    expect(long.split('/').pop()!.length).toBeLessThanOrEqual(150);
    expect(read(long)).toEqual({ season: 1, numbers: [2] });
    expect(long).toBe(`f/Season 01/Show Name - ${'x'.repeat(40)} - S01E02.mkv`);
    // A long title is cut too, and the last choice is the season and the episode alone.
    const veryLong = title({ meta: { ...title().meta, title: 'y'.repeat(300) } });
    expect(read(episodePath(veryLong, 'f', [episode(3, 4), episode(3, 5)], '.mkv', naming))).toEqual({ season: 3, numbers: [4, 5] });
    const bare = episodePath(veryLong, 'f', [episode(0, 1)], '.mkv', { ...DEFAULT_NAMING, episode: '{episodeTitle} {title} S{season}E{episode}' });
    expect(read(bare)).toEqual({ season: 0, numbers: [1] });
    expect(bare.split('/').pop()!.length).toBeLessThanOrEqual(150);
  });

  it('removes a separator that has no token on one side', () => {
    const show = title();
    const naming = { ...DEFAULT_NAMING, episode: '{title} - {episodeTitle} - S{season}E{episode}' };
    expect(episodePath(show, 'f', [episode(1, 2), episode(1, 3)], '.mkv', naming)).toBe('f/Season 01/Show Name - S01E02E03.mkv');
  });

  it('accepts only valid templates', () => {
    expect(templateProblem('movie', '{title} ({year})')).toBeNull();
    expect(templateProblem('episode', DEFAULT_NAMING.episode)).toBeNull();
    // A path separator would let a template leave the folder of the title.
    expect(templateProblem('movie', '../{title}')).toBe('template_separator');
    expect(templateProblem('movie', '{title}\\x')).toBe('template_separator');
    expect(templateProblem('movie', '{title} {season}')).toBe('template_token');
    expect(templateProblem('movie', '{title} {')).toBe('template_token');
    // Two episodes would get one name.
    expect(templateProblem('episode', '{title} - {episodeTitle}')).toBe('template_missing_token');
    expect(templateProblem('movie', '(year)')).toBe('template_missing_token');
    expect(templateProblem('movie', '   ')).toBe('template_invalid');
    expect(templateProblem('movie', 5)).toBe('template_invalid');
    // A rescan must read the season and the episodes from the name of one episode and of two episodes.
    expect(templateProblem('episode', '{title} {season}x{episode}')).toBe('template_unreadable');
    expect(templateProblem('episode', '{title} {season}{episode}')).toBe('template_unreadable');
    expect(templateProblem('episode', '{title} S{season}E{episode} {episodeTitle}')).toBeNull();
    expect(templateProblem('movie', `{title}${'x'.repeat(200)}`)).toBe('template_invalid');
  });

  it('shows a sample name for each template', () => {
    expect(exampleNames(DEFAULT_NAMING)).toEqual({ movie: 'Movie Name (2019)', episode: 'Show Name - S01E02 - Episode Name' });
    expect(exampleNames({ movie: '{title}', episode: '{title} S{season}E{episode}' })).toEqual({ movie: 'Movie Name', episode: 'Show Name S01E02' });
  });
});
