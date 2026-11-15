import { describe, expect, it } from 'vitest';
import { formatTags } from '../../src/library/probe.ts';

// The tags that ffprobe prints for a file of the library.
const tags = {
  title: 'Aye, Aye, Eyes/Dee Dee and the Man',
  DESCRIPTION: '...',
  SHOW: "Dexter's Laboratory",
  SEASON_NUMBER: '3',
  EPISODE_ID: '1',
  ENCODER: '...',
};

const expected = { title: 'Aye, Aye, Eyes/Dee Dee and the Man', season: 3, episode: 1 };

describe('the tags of a release', () => {
  it('reads the tags of an ffprobe run', () => {
    expect(formatTags({ tags })).toEqual(expected);
  });

  it('reads the same tags in lower case', () => {
    const lower = Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]));
    expect(formatTags({ tags: lower })).toEqual(expected);
  });

  it('trims a title that has spaces at both ends', () => {
    expect(formatTags({ tags: { title: '  Aye, Aye, Eyes  ' } }).title).toBe('Aye, Aye, Eyes');
  });
});

describe('a tag that is missing or empty', () => {
  it('gives three nulls when there are no tags', () => {
    expect(formatTags({})).toEqual({ title: null, season: null, episode: null });
    expect(formatTags(undefined)).toEqual({ title: null, season: null, episode: null });
  });

  it('gives null for an empty title and an empty season, not an empty string and not 0', () => {
    expect(formatTags({ tags: { title: '', SEASON_NUMBER: '' } })).toEqual({ title: null, season: null, episode: null });
  });
});

describe('the number of a release', () => {
  it('keeps episode 0', () => {
    expect(formatTags({ tags: { EPISODE_ID: '0' } }).episode).toBe(0);
  });

  it('gives null for a number that is not an integer', () => {
    expect(formatTags({ tags: { SEASON_NUMBER: '1a', EPISODE_ID: '2.5' } })).toEqual({ title: null, season: null, episode: null });
  });
});
