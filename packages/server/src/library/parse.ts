export type ParsedEpisodes = { season: number; numbers: number[] };

const MAX_RANGE = 50;
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|webm)$/i;
const SAMPLE = /(^|[^a-z0-9])sample([^a-z0-9]|$)/i;

export const isVideoFile = (name: string) => VIDEO.test(name);
// A sample is a short clip of a release. It is not the title.
export const isSample = (path: string) => SAMPLE.test(path);

// More episodes follow a marker as E03 (with or without a separator), or as -E04 or -04 (a range).
const TAIL = /(-?)[ ._-]*e?(\d{1,3})/gi;
// S01E02, with the episodes that follow it.
const SXE = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})((?:[ ._-]?e\d{1,3}|[-–][ ._-]?e?\d{1,3}(?!\d))*)/i;
// 1x02, with an optional range 1x02-04.
const NXN = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?(?![0-9a-z])/i;
// E02, Ep.02, Episode 02, Cap 02: an episode with no season in its own name.
const MARK = /(?:^|[^a-z0-9])(?:cap[ií]tulo|episode|cap|epi|ep|e)[ ._-]?(\d{1,3})((?:[ ._-]?e\d{1,3}|[-–][ ._-]?e?\d{1,3}(?!\d))*)/i;
// A folder or a prefix that names the season: "Season 01", "AoT - Season 3", "Temporada 2", "S03".
const SEASON_WORD = /(?:^|[^a-z0-9])(?:season|temporada|temporad|saison|staffel|stagione)[ ._-]?(\d{1,2})(?![0-9a-z])/i;
const SEASON_SHORT = /(?:^|[^a-z0-9])s(\d{1,2})(?![0-9a-z])/i;

// The first episode and the episodes that follow it. A dash between two numbers is a range.
function numbersFrom(first: number, tail: string | undefined) {
  const numbers = [first];
  if (!tail) return numbers;
  let previous = first;
  for (const [, dash, digits] of tail.matchAll(TAIL)) {
    const next = Number(digits);
    if (dash && next > previous && next - previous <= MAX_RANGE) for (let n = previous + 1; n <= next; n++) numbers.push(n);
    else numbers.push(next);
    previous = next;
  }
  return numbers;
}

// The season that a folder or a prefix of the name gives. A name with S01E02 has its own season, so the callers read it first.
function seasonOf(name: string): number | null {
  const word = SEASON_WORD.exec(name);
  if (word) return Number(word[1]);
  const short = SEASON_SHORT.exec(name);
  return short ? Number(short[1]) : null;
}

// The number at the end of the file name, when the path names the season: "Season 3/AoT - 04.mkv". A number that is part of
// another token, as the 1080 of 1080p or the 0 of 2.0, is not the episode. A path with no season does not give a number.
function lastNumber(name: string) {
  const stem = name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const found = /(?:^|[ ._-])(\d{1,3})$/.exec(stem);
  if (!found) return undefined;
  const before = stem.slice(0, found.index);
  if (/[0-9.]$/.test(before)) return undefined;
  return Number(found[1]);
}

// Reads the season and the episodes from a name: S01E02, S01E02E03, S01E02-E04, S01E02-04, 1x02, or the episode alone as
// E02, Ep.02, Episode 02 or Cap 02. The season of an episode with no season in its own name comes from the folder or the
// prefix that the caller passes in the same string ("Season 02/Berserk E01.mkv"), and season 1 when the string has none.
// A name that gives no season and episode returns nothing, so the file stays unmatched.
export function parseEpisodes(name: string): ParsedEpisodes | undefined {
  const sxe = SXE.exec(name);
  if (sxe) return { season: Number(sxe[1]), numbers: numbersFrom(Number(sxe[2]), sxe[3]) };
  const nxn = NXN.exec(name);
  if (nxn) {
    const first = Number(nxn[2]);
    const last = nxn[3] === undefined ? null : Number(nxn[3]);
    const numbers = last !== null && last > first && last - first <= MAX_RANGE ? Array.from({ length: last - first + 1 }, (_, index) => first + index) : [first];
    return { season: Number(nxn[1]), numbers };
  }
  const season = seasonOf(name);
  const marked = MARK.exec(name);
  if (marked) return { season: season ?? 1, numbers: numbersFrom(Number(marked[1]), marked[2]) };
  if (season === null) return undefined;
  const last = name.split('/').at(-1)!;
  const number = lastNumber(last);
  return number === undefined ? undefined : { season, numbers: [number] };
}

// A title can number the episodes of a season across the whole series, while a release starts again at 1 in each season.
// This gives the numbers of the title for the numbers of a file. A number that is already an episode of the season stays,
// and the other numbers are the position in the season. A number that is neither is not a match and is left out.
export function titleNumbers(parsed: ParsedEpisodes, episodes: { season: number; number: number }[]): number[] {
  const season = episodes.filter((episode) => episode.season === parsed.season).map((episode) => episode.number).sort((a, b) => a - b);
  const known = new Set(season);
  return parsed.numbers.flatMap((number) => {
    if (known.has(number)) return [number];
    const at = season[number - 1];
    return at === undefined ? [] : [at];
  });
}

// The numbering of a release that counts as two seasons what the title counts as one. `releaseSeason` is the season of
// the release, `season` the season of the title, and `from` the episode of the title that the release numbers as 1.
export type Continuation = { releaseSeason: number; season: number; from: number };

// The season and the episodes of the title that a file of a release names. A release of the rest of a season numbers its
// own season from 1, so its numbers are the places in that rest.
export function releaseEpisodes(name: string, episodes: { season: number; number: number }[], continuation?: Continuation | null): ParsedEpisodes | undefined {
  const parsed = parseEpisodes(name);
  if (!parsed) return undefined;
  if (continuation && parsed.season === continuation.releaseSeason) {
    return { season: continuation.season, numbers: titleNumbers({ season: continuation.season, numbers: parsed.numbers.map((number) => continuation.from + number - 1) }, episodes) };
  }
  return { season: parsed.season, numbers: titleNumbers(parsed, episodes) };
}
