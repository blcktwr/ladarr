import { describe, expect, it } from 'vitest';
import { matchContent, normalizeTitle } from '../../src/library/content.ts';
import type { CatalogEpisode, ContentMatch, FileEvidence } from '../../src/library/content.ts';

const ep = (season: number, number: number) => ({ season, number });

const entry = (season: number, number: number, name: string, airDate: string | null, runtime: number | null = 7): CatalogEpisode => ({ season, number, name, airDate, runtime });

const file = (path: string, extra: Partial<Omit<FileEvidence, 'path'>> = {}): FileEvidence => ({ path, title: null, season: null, episode: null, durationSeconds: null, ...extra });

// The proposals and the rejections of a call without the evidence line, to keep a table readable.
const answers = (result: ContentMatch) =>
  result.proposals.map(({ path, episodes, step, evidence }) => {
    expect(evidence.length).toBeGreaterThan(0);
    return { path, episodes, step };
  });

const rejections = (result: ContentMatch) =>
  result.rejections.map(({ path, reason, evidence }) => {
    expect(evidence.length).toBeGreaterThan(0);
    return { path, reason };
  });

// A series of 30-minute airings of two or three seven-minute segments. It lists only the airings
// these tests use, so the numbers of a season are sparse.
const catalog: CatalogEpisode[] = [
  // Season 1, airings of three segments.
  entry(1, 1, 'DeeDeemensional', '1996-04-27'),
  entry(1, 2, 'Dial M for Monkey: Magmanamus', '1996-04-27'),
  entry(1, 3, 'Maternal Combat', '1996-04-27'),
  entry(1, 4, 'Star Spangled Sidekicks', '1996-05-04'),
  entry(1, 5, 'The Justice Friends: TV Super Pals', '1996-05-04'),
  entry(1, 6, 'Game Over', '1996-05-04'),
  entry(1, 7, 'G.I.R.L. Squad', '1996-05-11'),
  entry(1, 8, "Ewww That's Growth", '1996-05-11'),
  entry(1, 9, 'Doomed Dimension', '1996-05-11'),
  // Season 2. A release calls the last airing S02E01; the catalog numbers it 21 to 23.
  entry(2, 1, 'Aye, Aye, Eyes', '1996-11-16'),
  entry(2, 2, 'Dee Dee and the Man', '1996-11-16'),
  entry(2, 5, "Dexter's Rival", '1996-12-07'),
  entry(2, 6, 'Dial M for Monkey: Barbequor', '1996-12-07'),
  entry(2, 21, 'Beard to Be Feared', '1997-02-08'),
  entry(2, 22, 'Quackor: The Fowl', '1997-02-08'),
  entry(2, 23, 'Ant Pants', '1997-02-08'),
  // Season 3.
  entry(3, 1, 'The Big Sister', '1997-04-05'),
  entry(3, 2, 'Dial M for Monkey: Organ Grinder', '1997-04-05'),
  // A special. Season 0 never takes part.
  entry(0, 1, 'Rude Removal', '1997-01-01'),
];

describe('titles', () => {
  it.each([
    ['Café Olé', 'cafe ole'], // accents
    ['Dee & Dee', 'dee and dee'], // the ampersand becomes the word
    ['Ants in the Pants!', 'ants in the pants'], // punctuation
    ['G.I.R.L. Squad', 'girl squad'], // the dots do not split the name
    ["Eww, That's Growth", 'eww thats growth'], // a comma and an apostrophe
    ['STAR SPANGLED Sidekicks', 'star spangled sidekicks'], // case
    ['  Double   Trouble  ', 'double trouble'], // repeated spaces
    ['', ''], // nothing
  ])('normalises "%s" to "%s"', (text, normalized) => {
    expect(normalizeTitle(text)).toBe(normalized);
  });
});

describe('a whole title', () => {
  const title = 'Beard to Be Feared/Quackor: The Fowl/Ant Pants';

  // The tags of the release do not win over the content: the airing is numbered 21 to 23.
  it.each([
    [2, 1],
    [4, 1],
  ])('maps the three segments to their airing with the tag season %s episode %s', (season, episode) => {
    const files = [file('beard.mkv', { title, season, episode, durationSeconds: 1326 })];
    expect(answers(matchContent(files, catalog))).toEqual([{ path: 'beard.mkv', episodes: [ep(2, 21), ep(2, 22), ep(2, 23)], step: 'whole_title' }]);
  });

  it('maps one segment to an airing of one episode, with the dots of the name', () => {
    // "G.I.R.L. Squad" aired alone, so one segment equals the whole airing.
    const local: CatalogEpisode[] = [
      entry(1, 7, 'G.I.R.L. Squad', null),
      entry(2, 1, 'Aye, Aye, Eyes', '1996-11-16'),
      entry(2, 2, 'Dee Dee and the Man', '1996-11-16'),
    ];
    const files = [file('girl.mkv', { title: 'G.I.R.L. Squad', durationSeconds: 1326 })];
    expect(answers(matchContent(files, local))).toEqual([{ path: 'girl.mkv', episodes: [ep(1, 7)], step: 'whole_title' }]);
  });
});

describe('an anchor segment', () => {
  it('resolves a title whose middle segment has another name', () => {
    const files = [file('dee.mkv', { title: 'DeeDeemensional/Magmanamus/Maternal Combat', durationSeconds: 1326 })];
    expect(answers(matchContent(files, catalog))).toEqual([{ path: 'dee.mkv', episodes: [ep(1, 1), ep(1, 2), ep(1, 3)], step: 'anchor' }]);
  });

  it('fills the other segments in the order of the airing', () => {
    const files = [file('justice.mkv', { title: 'Star Spangled Sidekicks/TV Super Pals/Game Over', durationSeconds: 1326 })];
    expect(answers(matchContent(files, catalog))).toEqual([{ path: 'justice.mkv', episodes: [ep(1, 4), ep(1, 5), ep(1, 6)], step: 'anchor' }]);
  });

  it('follows the content when the tags point at one episode of another season', () => {
    const files = [file('eyes.mkv', { title: 'Aye, Aye, Eyes/Dee Dee and the Man', season: 3, episode: 1, durationSeconds: 1326 })];
    expect(answers(matchContent(files, catalog))).toEqual([{ path: 'eyes.mkv', episodes: [ep(2, 1), ep(2, 2)], step: 'whole_title' }]);
  });
});

describe('a similar name', () => {
  // Two airings of three segments, so the global step has no single airing to give this file.
  const local: CatalogEpisode[] = [
    entry(1, 1, "Ewww That's Growth", '1996-05-11'),
    entry(1, 2, 'Nuclear Confusin', '1996-05-11'),
    entry(1, 3, 'Germ Warfares', '1996-05-11'),
    entry(1, 4, 'Old Man Dexter', '1996-05-18'),
    entry(1, 5, 'Double Trouble', '1996-05-18'),
    entry(1, 6, 'Jurassic Pooch', '1996-05-18'),
  ];

  it('accepts one airing when no segment matches exactly', () => {
    const files = [file('fuzzy.mkv', { title: "Eww, That's Growth/Nuclear Confusion/Germ Warfare", durationSeconds: 1326 })];
    expect(answers(matchContent(files, local))).toEqual([{ path: 'fuzzy.mkv', episodes: [ep(1, 1), ep(1, 2), ep(1, 3)], step: 'fuzzy' }]);
  });

  it('does not bridge a segment that only keeps the last word', () => {
    const files = [file('magmanamus.mkv', { title: 'Magmanamus', durationSeconds: 1326 })];
    const result = matchContent(files, catalog);
    expect(answers(result)).toEqual([]);
    expect(rejections(result)).toEqual([{ path: 'magmanamus.mkv', reason: 'no_match' }]);
  });
});

describe('the duration of a file', () => {
  it('does not fit an airing of 42 minutes into a file of 1326 seconds', () => {
    const local: CatalogEpisode[] = [
      entry(1, 1, 'DeeDeemensional', '1996-04-27', 14),
      entry(1, 2, 'Dial M for Monkey: Magmanamus', '1996-04-27', 14),
      entry(1, 3, 'Maternal Combat', '1996-04-27', 14),
      // An airing of two segments, so the global step has no airing of three segments to offer.
      entry(1, 4, 'Old Man Dexter', '1996-05-04'),
      entry(1, 5, 'Double Trouble', '1996-05-04'),
    ];
    const files = [file('long.mkv', { title: 'DeeDeemensional/Magmanamus/Maternal Combat', durationSeconds: 1326 })];
    const result = matchContent(files, local);
    expect(answers(result)).toEqual([]);
    expect(rejections(result)).toEqual([{ path: 'long.mkv', reason: 'no_match' }]);
  });

  it('fits an airing of 21 minutes into a file of 1326 seconds', () => {
    const local: CatalogEpisode[] = [
      entry(1, 1, 'DeeDeemensional', '1996-04-27'),
      entry(1, 2, 'Dial M for Monkey: Magmanamus', '1996-04-27'),
      entry(1, 3, 'Maternal Combat', '1996-04-27'),
    ];
    const files = [file('short.mkv', { title: 'DeeDeemensional/Magmanamus/Maternal Combat', durationSeconds: 1326 })];
    expect(answers(matchContent(files, local))).toEqual([{ path: 'short.mkv', episodes: [ep(1, 1), ep(1, 2), ep(1, 3)], step: 'anchor' }]);
  });
});

describe('steps that disagree', () => {
  it('rejects a title whose exact segments belong to two airings', () => {
    const files = [file('mix.mkv', { title: 'DeeDeemensional/Maternal Combat/Game Over', durationSeconds: 1326 })];
    const result = matchContent(files, catalog);
    expect(answers(result)).toEqual([]);
    expect(rejections(result)).toEqual([{ path: 'mix.mkv', reason: 'conflict' }]);
  });
});

describe('the files of one call', () => {
  // Three airings: one of three segments for the whole title, one of three and one of two for the rest.
  const local: CatalogEpisode[] = [
    entry(1, 1, 'DeeDeemensional', '1996-04-27'),
    entry(1, 2, 'Dial M for Monkey: Magmanamus', '1996-04-27'),
    entry(1, 3, 'Maternal Combat', '1996-04-27'),
    entry(1, 4, 'Star Spangled Sidekicks', '1996-05-04'),
    entry(1, 5, 'The Justice Friends: TV Super Pals', '1996-05-04'),
    entry(1, 6, 'Game Over', '1996-05-04'),
    entry(1, 7, 'Aye, Aye, Eyes', '1996-05-11'),
    entry(1, 8, 'Dee Dee and the Man', '1996-05-11'),
  ];

  it('gives the remaining airings to the files that match nothing', () => {
    const files = [
      file('whole.mkv', { title: 'DeeDeemensional/Dial M for Monkey: Magmanamus/Maternal Combat', durationSeconds: 1326 }),
      file('three.mkv', { title: 'Blah One/Blah Two/Blah Three', durationSeconds: 1326 }),
      file('two.mkv', { title: 'Blah Four/Blah Five', durationSeconds: 1326 }),
    ];
    expect(answers(matchContent(files, local))).toEqual([
      { path: 'whole.mkv', episodes: [ep(1, 1), ep(1, 2), ep(1, 3)], step: 'whole_title' },
      { path: 'three.mkv', episodes: [ep(1, 4), ep(1, 5), ep(1, 6)], step: 'global' },
      { path: 'two.mkv', episodes: [ep(1, 7), ep(1, 8)], step: 'global' },
    ]);
  });
});

describe('the number of a release', () => {
  it('uses the tags of a file without a title', () => {
    const files = [file('tag.mkv', { season: 2, episode: 5 })];
    expect(answers(matchContent(files, catalog))).toEqual([{ path: 'tag.mkv', episodes: [ep(2, 5)], step: 'release_number' }]);
  });

  it('does not use the tags of a file with three segments', () => {
    const files = [file('tag-three.mkv', { title: 'Blah One/Blah Two/Blah Three', season: 2, episode: 5, durationSeconds: 1326 })];
    const result = matchContent(files, catalog);
    expect(answers(result)).toEqual([]);
    // The spec does not fix the reason of a file that leaves more than one airing possible.
    expect(rejections(result)).toEqual([{ path: 'tag-three.mkv', reason: expect.stringMatching(/^(ambiguous|no_match)$/) }]);
  });

  it('rejects a second file that asks for an episode that another file took', () => {
    const files = [file('first.mkv', { season: 2, episode: 5 }), file('second.mkv', { season: 2, episode: 5 })];
    const result = matchContent(files, catalog);
    expect(answers(result)).toEqual([{ path: 'first.mkv', episodes: [ep(2, 5)], step: 'release_number' }]);
    expect(rejections(result)).toEqual([{ path: 'second.mkv', reason: 'conflict' }]);
  });
});

describe('episodes that stay out', () => {
  it('never proposes an episode of season 0', () => {
    const files = [file('special.mkv', { title: 'Rude Removal', durationSeconds: 1326 })];
    const result = matchContent(files, catalog);
    expect(answers(result)).toEqual([]);
    expect(rejections(result)).toEqual([{ path: 'special.mkv', reason: 'no_match' }]);
  });

  it('never proposes episodes of two seasons in one file', () => {
    const local: CatalogEpisode[] = [
      entry(1, 1, 'Aye, Aye, Eyes', '1996-11-16'),
      entry(1, 2, 'Dee Dee and the Man', '1996-11-16'),
      entry(2, 1, "Dexter's Rival", '1996-12-07'),
      entry(2, 2, 'Dial M for Monkey: Barbequor', '1996-12-07'),
    ];
    const files = [file('two-seasons.mkv', { title: 'Aye, Aye, Eyes/Dial M for Monkey: Barbequor', durationSeconds: 1326 })];
    const result = matchContent(files, local);
    expect(answers(result)).toEqual([]);
    expect(rejections(result)).toEqual([{ path: 'two-seasons.mkv', reason: 'conflict' }]);
  });
});

describe('a call', () => {
  const files = [
    file('beard.mkv', { title: 'Beard to Be Feared/Quackor: The Fowl/Ant Pants', durationSeconds: 1326 }),
    file('justice.mkv', { title: 'Star Spangled Sidekicks/TV Super Pals/Game Over', durationSeconds: 1326 }),
    file('magmanamus.mkv', { title: 'Magmanamus', durationSeconds: 1326 }),
  ];

  it('answers the same way twice', () => {
    expect(matchContent(files, catalog)).toEqual(matchContent(files, catalog));
  });

  it('never proposes an episode that another proposal of the call contains', () => {
    const result = matchContent(files, catalog);
    expect(answers(result)).toEqual([
      { path: 'beard.mkv', episodes: [ep(2, 21), ep(2, 22), ep(2, 23)], step: 'whole_title' },
      { path: 'justice.mkv', episodes: [ep(1, 4), ep(1, 5), ep(1, 6)], step: 'anchor' },
    ]);
    expect(rejections(result)).toEqual([{ path: 'magmanamus.mkv', reason: 'no_match' }]);

    const seen = new Set<string>();
    for (const { episodes } of result.proposals) {
      for (const { season, number } of episodes) {
        expect(seen.has(`${season}-${number}`)).toBe(false);
        seen.add(`${season}-${number}`);
      }
    }
  });
});
