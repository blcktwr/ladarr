import type { Numbering, NumberingRange } from '@ladarr/shared/types';

// The two coordinate systems of a series. The catalog is the numbering of TMDB, which ladarr stores. The release is the
// numbering of the indexers, the torrents, and the files that they hold. They differ when a release counts as another
// season what TMDB counts as the last episodes of a season, as the release of Kaiju No. 8 does with S02E01.
export type Point = { season: number; number: number };

export const NO_NUMBERING: Numbering = { revision: 0, ranges: [] };

// The most episodes that one range can hold. It keeps a bad request from a loop of a million steps.
const MAX_SPAN = 1_000;

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

// A saved record from an older version has no numbering. It uses the numbering of the catalog.
export const normalizeNumbering = (value: Numbering | null | undefined): Numbering => (value && Array.isArray(value.ranges) ? value : NO_NUMBERING);

export const seasonRevision = (map: Numbering | undefined | null, season: number | null) =>
  map?.ranges.some((range) => range.season !== range.releaseSeason && (range.season === season || range.releaseSeason === season)) ? map.revision : undefined;

// The last release episode of a range. The length of the range fixes it, so a release that ends earlier or later does
// not extend the mapping.
export const releaseTo = (range: NumberingRange) => range.releaseFrom + range.to - range.from;

export function rangeOfCatalog(numbering: Numbering, season: number, number: number): NumberingRange | null {
  return numbering.ranges.find((range) => range.season === season && number >= range.from && number <= range.to) ?? null;
}

export function rangeOfRelease(numbering: Numbering, releaseSeason: number, releaseNumber: number): NumberingRange | null {
  return numbering.ranges.find((range) => range.releaseSeason === releaseSeason && releaseNumber >= range.releaseFrom && releaseNumber <= releaseTo(range)) ?? null;
}

// The release point of a catalog episode. Outside a saved range the two coordinate systems agree, unless an explicit
// range already gives that release point to another episode. That collision leaves the target without a release point.
export function releasePoint(numbering: Numbering, catalog: Point): Point | null {
  const range = rangeOfCatalog(numbering, catalog.season, catalog.number);
  if (range) return { season: range.releaseSeason, number: range.releaseFrom + catalog.number - range.from };
  return rangeOfRelease(numbering, catalog.season, catalog.number) ? null : catalog;
}

// The catalog point of a release episode. The reverse of releasePoint, with the same identity rule.
export function catalogPoint(numbering: Numbering, release: Point): Point | null {
  const range = rangeOfRelease(numbering, release.season, release.number);
  if (range) return { season: range.season, number: range.from + release.number - range.releaseFrom };
  return rangeOfCatalog(numbering, release.season, release.number) ? null : release;
}

// The catalog episodes of several release numbers of one season, or null when one of them has no catalog episode.
export function catalogPoints(numbering: Numbering, releaseSeason: number, numbers: number[]): { season: number; numbers: number[] } | null {
  const found = new Set<number>();
  let season: number | null = null;
  for (const number of numbers) {
    const point = catalogPoint(numbering, { season: releaseSeason, number });
    if (!point) return null;
    if (season !== null && point.season !== season) return null;
    season = point.season;
    found.add(point.number);
  }
  return season === null ? null : { season, numbers: [...found].sort((a, b) => a - b) };
}

// The release seasons of the episodes of one catalog season: the saved ranges first, and the catalog season itself.
export function releaseSeasons(numbering: Numbering, catalogSeason: number): number[] {
  const seasons = new Set<number>([catalogSeason]);
  for (const range of numbering.ranges) if (range.season === catalogSeason) seasons.add(range.releaseSeason);
  return [...seasons].sort((a, b) => a - b);
}

// The catalog seasons whose episodes a release season holds. A release season usually holds the episodes of one catalog
// season, but two seasons can map onto one release season. The catalog season comes first when it has no range.
export function catalogSeasons(numbering: Numbering, releaseSeason: number): number[] {
  const seasons = new Set<number>();
  for (const range of numbering.ranges) if (range.releaseSeason === releaseSeason) seasons.add(range.season);
  if (!seasons.size) seasons.add(releaseSeason);
  return [...seasons].sort((a, b) => a - b);
}

// The catalog episodes of a release season, in catalog order. The identity numbers count when no explicit range gives
// their release coordinate to another episode.
export function catalogEpisodesOfReleaseSeason(numbering: Numbering, releaseSeason: number, episodes: Point[]): Point[] {
  return episodes
    .filter((episode) => releasePoint(numbering, episode)?.season === releaseSeason)
    .sort((a, b) => a.season - b.season || a.number - b.number);
}

// The saved ranges are in one canonical order, so two equal maps are equal for a comparison.
const sorted = (ranges: NumberingRange[]): NumberingRange[] =>
  [...ranges].sort((a, b) => a.season - b.season || a.from - b.from || a.releaseSeason - b.releaseSeason || a.releaseFrom - b.releaseFrom);

export function sameNumbering(a: Numbering, b: Numbering): boolean {
  return a.revision === b.revision && JSON.stringify(a.ranges) === JSON.stringify(b.ranges);
}

// Keep the release numbers of untouched episodes. Give each moved episode the first free number in its new season.
export function assignSeasons(current: Numbering, episodes: Point[], edits: unknown) {
  if (!Array.isArray(edits) || edits.length > episodes.length) return null;
  const key = ({ season, number }: Point) => `${season}x${number}`;
  const catalog = new Set(episodes.map(key));
  const changes = new Map<string, number>();
  const search = new Set<string>();
  let changed = false;
  for (const edit of edits) {
    if (!edit || !integer(edit.season) || !integer(edit.number) || !integer(edit.releaseSeason) || edit.releaseSeason < 0 || typeof edit.search !== 'boolean') return null;
    const id = key(edit);
    if (!catalog.has(id) || changes.has(id)) return null;
    changes.set(id, edit.releaseSeason);
    if (releasePoint(current, edit)?.season !== edit.releaseSeason) {
      changed = true;
      if (edit.search) search.add(id);
    }
  }
  if (!changed) return { numbering: current, search };
  const ordered = [...episodes].sort((a, b) => a.season - b.season || a.number - b.number);
  const occupied = new Set<string>();
  const mapped = new Map<string, Point>();
  const moved: Point[] = [];
  for (const point of ordered) {
    const id = key(point);
    const next = changes.get(id);
    const release = releasePoint(current, point);
    if (next !== undefined && next !== release?.season && next !== point.season) {
      moved.push(point);
      continue;
    }
    const reset = next === point.season && next !== release?.season;
    const keep = reset ? point : release;
    if (!keep) continue;
    if (occupied.has(key(keep))) return null;
    occupied.add(key(keep));
    if (!reset && rangeOfCatalog(current, point.season, point.number)) mapped.set(id, keep);
  }
  const nextNumber = new Map<number, number>();
  for (const point of moved) {
    const season = changes.get(key(point))!;
    let number = nextNumber.get(season) ?? 1;
    while (occupied.has(key({ season, number }))) number++;
    mapped.set(key(point), { season, number });
    nextNumber.set(season, number + 1);
  }
  const ranges: NumberingRange[] = [];
  for (const point of ordered) {
    const release = mapped.get(key(point));
    if (!release) continue;
    const last = ranges.at(-1);
    if (last && last.season === point.season && last.to + 1 === point.number && point.number - last.from < MAX_SPAN
      && last.releaseSeason === release.season && releaseTo(last) + 1 === release.number) last.to = point.number;
    else ranges.push({ season: point.season, from: point.number, to: point.number, releaseSeason: release.season, releaseFrom: release.number });
  }
  const check = validateNumbering({ revision: current.revision, ranges });
  return check.ok ? { numbering: check.numbering, search } : null;
}

export type NumberingProblem = { error: 'invalid_numbering'; index?: number; field?: string };
export type NumberingCheck = { ok: true; numbering: Numbering } | ({ ok: false } & NumberingProblem);

const invalid = (index: number, field: string): NumberingCheck => ({ ok: false, error: 'invalid_numbering', index, field });

// Checks the shape and the limits of a map that a user saved. The catalog episodes are checked against the title by the
// caller, because this module knows no episodes.
export function validateNumbering(value: unknown): NumberingCheck {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'invalid_numbering' };
  const { revision, ranges } = value as { revision?: unknown; ranges?: unknown };
  if (!integer(revision) || revision < 0) return invalid(-1, 'revision');
  if (!Array.isArray(ranges) || ranges.length > 500) return invalid(-1, 'ranges');
  const list: NumberingRange[] = [];
  for (const [index, item] of ranges.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return invalid(index, 'range');
    const { season, from, to, releaseSeason, releaseFrom } = item as Partial<NumberingRange>;
    if (!integer(season) || season < 0) return invalid(index, 'season');
    if (!integer(from) || from < 1) return invalid(index, 'from');
    if (!integer(to) || to < 1) return invalid(index, 'to');
    if (from > to) return invalid(index, 'to');
    if (to - from >= MAX_SPAN) return invalid(index, 'to');
    if (!integer(releaseSeason) || releaseSeason < 0) return invalid(index, 'releaseSeason');
    if (!integer(releaseFrom) || releaseFrom < 1) return invalid(index, 'releaseFrom');
    list.push({ season, from, to, releaseSeason, releaseFrom });
  }
  const ordered = sorted(list);
  // Two catalog ranges can not share an episode, and two release ranges can not share a release episode. Either would
  // give one target two release coordinates, or one release episode two targets.
  for (let later = 0; later < ordered.length; later++) {
    const current = ordered[later]!;
    for (let earlier = 0; earlier < later; earlier++) {
      const other = ordered[earlier]!;
      if (current.season === other.season && current.from <= other.to && other.from <= current.to) return invalid(later, 'from');
      if (current.releaseSeason === other.releaseSeason && current.releaseFrom <= releaseTo(other) && other.releaseFrom <= releaseTo(current)) return invalid(later, 'releaseFrom');
    }
  }
  return { ok: true, numbering: { revision, ranges: ordered } };
}
