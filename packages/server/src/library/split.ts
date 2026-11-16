import type { Split } from '../types.ts';
// The releases do not always number the seasons as TMDB does. A release can put in its season 2 what TMDB puts in the
// last episodes of its season 1, and a release season can hold a whole season of TMDB under another number. The files
// of a pack are the evidence of the mapping: their numbers are the numbers of the release, and the pack ends where the
// TMDB season ends.

// The episode of TMDB that a release episode names. The release numbers its episodes from 1, so the TMDB episode of the
// release number `number` is `from + number - 1`.
export const placeOf = (split: Split, number: number) => split.from + number - 1;

// The mapping that the numbers of the files of a pack establish, from the last episodes of a season of TMDB.
// `numbers` are the release numbers of the video files of the pack. `missing` are the TMDB episodes that still need a
// file. A pack that gives no single mapping returns null: its targets stay without a file.
export function splitOf({ total, numbers, missing }: { season: number; total: number; numbers: number[]; missing: number[] }): Split | null {
  if (!numbers.length || !missing.length || total < 1) return null;
  // The files of a pack of the rest of a season start at the first episode of the season of the release. A pack that
  // starts later can be a part of a release of the whole season, and its numbers then give no place.
  const ordered = [...new Set(numbers)].sort((a, b) => a - b);
  if (ordered[0] !== 1) return null;
  if (ordered.some((number, index) => number !== index + 1)) return null;
  const last = ordered.at(-1)!;
  if (last > total) return null;
  // The release season ends where the season of TMDB ends, so the last episode of the pack is the last episode of the
  // season. The other episodes of the pack are the ones before it.
  const from = total - last + 1;
  if (from < 1) return null;
  // A pack that holds none of the episodes that need a file gives no answer to this season.
  if (!missing.some((number) => number >= from && number <= total)) return null;
  return { from };
}
