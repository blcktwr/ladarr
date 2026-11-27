import type { EpisodeFacts, Numbering, ParsedEpisodes } from '../types.ts';
import { catalogPoints } from './numbering.ts';
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
// YYYY-MM-DD, YYYY.MM.DD or YYYY MM DD, as a daily release or a folder names it.
const AIR_DATE = /(?:^|[^0-9])((?:19|20)\d{2})[ ._-](0[1-9]|1[0-2])[ ._-](0[1-9]|[12]\d|3[01])(?![0-9])/;

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

// The season that a folder or a prefix of the name gives. A name with S01E02 has its own season, so the callers read it
// first. The folder closest to the file name wins, because a release of one season can sit in a folder that names
// another: "Season 01/Show.S02/Show - 04.mkv" is an episode of season 2.
function seasonOf(name: string): number | null {
  for (const segment of name.split('/').reverse()) {
    const word = SEASON_WORD.exec(segment);
    if (word) return Number(word[1]);
    const short = SEASON_SHORT.exec(segment);
    if (short) return Number(short[1]);
  }
  return null;
}

// The number at the end of the file name: the episode of a file in a season folder ("Season 3/AoT - 04.mkv"), or the
// absolute position of an anime release. A number that is part of another token, as the 1080 of 1080p or the 0 of 2.0,
// is not the episode.
function lastNumber(name: string) {
  const stem = name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const found = /(?:^|[ ._-])(\d{1,3})$/.exec(stem);
  if (!found) return undefined;
  const before = stem.slice(0, found.index);
  if (/[0-9.]$/.test(before) || /(?:^|[ ._-])(?:disc|disk|disco|cd|dvd|bd)[ ._-]*$/i.test(before)) return undefined;
  return Number(found[1]);
}

// Reads the season and the episodes from a name: S01E02, S01E02E03, S01E02-E04, S01E02-04, 1x02, or the episode alone as
// E02, Ep.02, Episode 02 or Cap 02. The season of an episode with no season in its own name comes from the folder or the
// prefix that the caller passes in the same string ("Season 02/Berserk E01.mkv"), from the hint of the caller, and season 1
// when the string has none and the caller gives no hint. A name that gives no season and episode returns nothing, so the
// file stays unmatched.
export function parseEpisodes(name: string, seasonHint?: number | null): ParsedEpisodes | undefined {
  const slash = name.lastIndexOf('/');
  if (slash >= 0) {
    const folder = name.slice(0, slash);
    const marker = SXE.exec(folder) ?? NXN.exec(folder);
    const season = seasonOf(folder) ?? (marker ? Number(marker[1]) : seasonHint);
    const file = parseEpisodes(name.slice(slash + 1), season);
    if (file) return file;
  }
  const sxe = SXE.exec(name);
  if (sxe) return { season: Number(sxe[1]), numbers: numbersFrom(Number(sxe[2]), sxe[3]) };
  const nxn = NXN.exec(name);
  if (nxn) {
    const first = Number(nxn[2]);
    const last = nxn[3] === undefined ? null : Number(nxn[3]);
    const numbers = last !== null && last > first && last - first <= MAX_RANGE ? Array.from({ length: last - first + 1 }, (_, index) => first + index) : [first];
    return { season: Number(nxn[1]), numbers };
  }
  const season = seasonOf(name) ?? seasonHint ?? null;
  const marked = MARK.exec(name);
  if (marked) return { season: season ?? 1, numbers: numbersFrom(Number(marked[1]), marked[2]) };
  if (season === null) return undefined;
  const last = name.split('/').at(-1)!;
  const number = lastNumber(last);
  return number === undefined ? undefined : { season, numbers: [number] };
}

// Only catalog numbers count here. A source map must convert release numbers before this step.
export function titleNumbers(parsed: ParsedEpisodes, episodes: { season: number; number: number }[]): number[] {
  const known = new Set(episodes.filter((episode) => episode.season === parsed.season).map((episode) => episode.number));
  return parsed.numbers.filter((number) => known.has(number));
}

// The season and the episodes of the title that a file of a release names. The numbers of the file are the numbers of
// the release, and the numbering maps them to the episodes of the title. A number outside the saved ranges keeps its
// own season and episode. A number that an explicit range claims for another episode gives no match: the file
// contradicts the map, so no fallback takes it.
// The file and its path give more than a marker: an air date, the absolute position of an anime release, and the name of
// the episode. They count in that order, because a marker in the name is the most precise signal.
export function releaseEpisodes(name: string, episodes: EpisodeFacts[], numbering?: Numbering | null, seasonHint?: number | null, titleName?: string | null): ParsedEpisodes | undefined {
  const parsed = parseEpisodes(name, seasonHint);
  if (parsed) {
    if (numbering?.ranges.length) {
      const converted = catalogPoints(numbering, parsed.season, parsed.numbers);
      return converted ? { season: converted.season, numbers: titleNumbers(converted, episodes) } : undefined;
    }
    return { season: parsed.season, numbers: titleNumbers(parsed, episodes) };
  }
  // A hint of the caller leaves the episodes of one season, so a date or a name that two seasons share is not a doubt.
  const season = seasonHint ?? null;
  const candidates = season === null ? episodes : episodes.filter((episode) => episode.season === season);
  // Two episodes with the same date or the same name are not a match.
  const one = (found: EpisodeFacts[]) => (found.length === 1 ? { season: found[0]!.season, numbers: [found[0]!.number] } : undefined);

  // A daily release names its air date, and no episode number.
  const date = AIR_DATE.exec(name);
  if (date) return one(candidates.filter((episode) => episode.airDate === `${date[1]}-${date[2]}-${date[3]}`));

  // An anime release counts its episodes across the whole series, and its file names hold the number alone. A season in
  // the path or a hint of the caller makes the number an episode of that season, so it is not a position.
  if (season === null && seasonOf(name) === null) {
    const loose = lastNumber(name.split('/').at(-1)!);
    if (loose !== undefined) {
      const ordered = episodes.filter((episode) => episode.season > 0).sort((a, b) => a.season - b.season || a.number - b.number);
      const at = ordered[loose - 1];
      return at ? { season: at.season, numbers: [at.number] } : undefined;
    }
  }

  // The file names the episode and no number: "Show Name - The Battle.mkv". The name of the title at its front is not
  // part of the name of the episode.
  const stem = normalizeName(name.split('/').at(-1)!.replace(/\.[a-z0-9]{2,4}$/i, ''));
  const title = titleName ? normalizeName(titleName) : '';
  const rest = title && stem.startsWith(title) ? stem.slice(title.length).trim() : stem;
  if (!rest || rest === title) return undefined;
  return one(candidates.filter((episode) => episode.name !== undefined && normalizeName(episode.name) === rest));
}

// The words of a name, for a comparison: no case, no accents, `&` as `and`, no apostrophes, one space between words.
// A leading article stays, because it is part of the name of an episode: "The Battle" is not "Battle".
function normalizeName(text: string) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
