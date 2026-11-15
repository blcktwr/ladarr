// Maps the files of a download to the episodes that they contain. A release does not always follow the numbering of
// TMDB: one release can split a season in another way, or number a season that TMDB puts in another one. So the
// numbers of the release are the last evidence, and the names of the segments come first.

import type { ProbeResult } from './probe.ts';

export type CatalogEpisode = {
  season: number;
  number: number;
  name: string;
  // "1998-02-18". The episodes of one airing share it.
  airDate: string | null;
  // The minutes of this segment. Null when TMDB does not give it.
  runtime: number | null;
};

// What one file of a download says about itself.
export type FileEvidence = {
  // The file in the download, relative to its folder.
  path: string;
  // The tag `title`, for example "Aye, Aye, Eyes/Dee Dee and the Man".
  title: string | null;
  // The tags `SEASON_NUMBER` and `EPISODE_ID`. They hold the numbering of the release, not the one of TMDB.
  season: number | null;
  episode: number | null;
  durationSeconds: number | null;
};

// The step of the cascade that gave the answer. A person reads it in the preview, so a weak step is visible.
export type ContentStep = 'whole_title' | 'segments' | 'anchor' | 'global' | 'fuzzy' | 'release_number';

export type ContentProposal = {
  path: string;
  episodes: { season: number; number: number }[];
  step: ContentStep;
  evidence: string;
};

// `conflict`: two steps gave different episodes. `ambiguous`: more than one airing stays possible.
// `no_match`: no step found an airing.
export type ContentRejection = { path: string; reason: 'ambiguous' | 'conflict' | 'no_match'; evidence: string };

export type ContentMatch = { proposals: ContentProposal[]; rejections: ContentRejection[] };

// The evidence that the matcher reads from one file, from the probe of that file. A file that ffprobe could not read
// gives no evidence, and the cascade then has only the name and the numbering of the release.
export function evidenceOf(path: string, probe: ProbeResult): FileEvidence {
  if (probe.ok !== true) return { path, title: null, season: null, episode: null, durationSeconds: null };
  return {
    path,
    title: probe.tags?.title ?? null,
    season: probe.tags?.season ?? null,
    episode: probe.tags?.episode ?? null,
    durationSeconds: probe.durationSeconds,
  };
}

// The episodes that aired as one broadcast, in the order of their numbers.
type Airing = CatalogEpisode[];

// Lowercase, no accents, `&` as `and`. The stops and the quotes inside a name go, so "G.I.R.L. Squad" and "girl
// squad" are one name, and "Eww, That's Growth" and "Eww thats growth" are one name. Every other separator, as the
// slash between the segments, becomes one space.
export function normalizeTitle(text: string) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.'’,:;!?"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// The segments of the tag `title`. The release separates them with a slash.
function segmentsOf(title: string | null) {
  if (!title) return [];
  return title
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

// The episodes of one season with one air date are one airing. An episode with no date is alone.
// The specials of season 0 are outside the matching.
function airingsOf(episodes: CatalogEpisode[]): Airing[] {
  const sorted = episodes.filter((episode) => episode.season > 0).sort((a, b) => a.season - b.season || a.number - b.number);
  const airings: Airing[] = [];
  let key: string | null = null;
  for (const episode of sorted) {
    const next = episode.airDate === null ? `alone:${episode.season}:${episode.number}` : `${episode.season}:${episode.airDate}`;
    if (next !== key) {
      airings.push([]);
      key = next;
    }
    airings.at(-1)!.push(episode);
  }
  return airings;
}

const position = (episode: { season: number; number: number }) => `${episode.season}x${episode.number}`;

// The sum of the runtimes of an airing in minutes. Null when one of them is unknown.
function runtimeOf(airing: Airing) {
  let total = 0;
  for (const episode of airing) {
    if (episode.runtime === null) return null;
    total += episode.runtime;
  }
  return total;
}

// True when the content of the airing fits in the file. A file can hold more than its airing, because the airing of
// TMDB can leave out a short segment, so only too much content is impossible. An unknown runtime or duration fits.
function fits(airing: Airing, durationSeconds: number | null) {
  const minutes = runtimeOf(airing);
  if (!durationSeconds || !minutes) return true;
  const seconds = minutes * 60;
  return seconds <= durationSeconds + Math.max(90, 0.15 * seconds);
}

// The number of single letters to add, remove or change, against the longer name. A short name inside a long one
// scores low, which keeps a prefix from passing as the name, and one letter in a long name scores high.
function similarity(a: string, b: string) {
  if (!a || !b) return a === b ? 1 : 0;
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let at = 1; at <= a.length; at++) {
    const current = [at];
    for (let other = 1; other <= b.length; other++) {
      const change = a[at - 1] === b[other - 1] ? 0 : 1;
      current[other] = Math.min(previous[other]! + 1, current[other - 1]! + 1, previous[other - 1]! + change);
    }
    previous = current;
  }
  return 1 - previous[b.length]! / Math.max(a.length, b.length);
}

// The evidence of a proposal that names an airing, for a person who reads the preview.
function describe(airing: Airing) {
  return airing.map((episode) => `S${String(episode.season).padStart(2, '0')}E${String(episode.number).padStart(2, '0')} ${episode.name}`).join(' | ');
}

type Context = {
  episodes: CatalogEpisode[];
  airings: Airing[];
  // The airing of each episode, by its position in `airings`.
  airingOf: Map<CatalogEpisode, number>;
  // The episodes that answer to a normalised name. A name that answers twice can not identify one episode.
  byName: Map<string, CatalogEpisode[]>;
  // The airings that answer to a normalised whole title.
  byWholeTitle: Map<string, Airing[]>;
  // The episode of a season and a number in the catalog.
  byPosition: Map<string, CatalogEpisode>;
  normalized: Map<CatalogEpisode, string>;
};

function contextOf(episodes: CatalogEpisode[]): Context {
  const airings = airingsOf(episodes);
  const context: Context = { episodes, airings, airingOf: new Map(), byName: new Map(), byWholeTitle: new Map(), byPosition: new Map(), normalized: new Map() };
  for (const [index, airing] of airings.entries()) {
    const names = airing.map((episode) => normalizeTitle(episode.name));
    for (const episode of airing) {
      context.airingOf.set(episode, index);
      context.normalized.set(episode, normalizeTitle(episode.name));
      context.byName.set(context.normalized.get(episode)!, [...(context.byName.get(context.normalized.get(episode)!) ?? []), episode]);
      context.byPosition.set(position(episode), episode);
    }
    const whole = names.join(' ');
    context.byWholeTitle.set(whole, [...(context.byWholeTitle.get(whole) ?? []), airing]);
  }
  return context;
}

// The tag `title` is the names of the segments of one airing, in its order.
function byWholeTitle(file: FileEvidence, context: Context) {
  const segments = segmentsOf(file.title);
  if (!segments.length) return;
  const found = (context.byWholeTitle.get(normalizeTitle(file.title!)) ?? []).filter((airing) => airing.length === segments.length && fits(airing, file.durationSeconds));
  return found.length === 1 ? found[0] : undefined;
}

// Each segment is the exact name of one episode, and those episodes are one airing in that order.
function bySegments(file: FileEvidence, context: Context) {
  const segments = segmentsOf(file.title);
  if (!segments.length) return;
  const matched: CatalogEpisode[] = [];
  for (const segment of segments) {
    const found = context.byName.get(normalizeTitle(segment)) ?? [];
    if (found.length !== 1) return;
    matched.push(found[0]!);
  }
  const index = context.airingOf.get(matched[0]!);
  const airing = index === undefined ? undefined : context.airings[index]!;
  if (!airing || airing.length !== matched.length) return;
  if (!airing.every((episode, at) => episode === matched[at])) return;
  return fits(airing, file.durationSeconds) ? airing : undefined;
}

// One or more segments name an episode without doubt. They put the file in one airing, and the other segments take
// the places of that airing in order. A segment that names an episode of another airing contradicts this one.
function byAnchor(file: FileEvidence, context: Context): { airing: Airing } | { conflict: true } | undefined {
  const segments = segmentsOf(file.title);
  if (!segments.length) return;
  const anchors: { at: number; episode: CatalogEpisode }[] = [];
  for (const [at, segment] of segments.entries()) {
    const found = context.byName.get(normalizeTitle(segment)) ?? [];
    if (found.length === 1) anchors.push({ at, episode: found[0]! });
  }
  if (!anchors.length) return;
  const indexes = new Set(anchors.map((anchor) => context.airingOf.get(anchor.episode)!));
  if (indexes.size > 1) return { conflict: true };
  const airing = context.airings[[...indexes][0]!]!;
  if (airing.length !== segments.length) return;
  if (anchors.some((anchor) => airing.indexOf(anchor.episode) !== anchor.at)) return;
  return fits(airing, file.durationSeconds) ? { airing } : undefined;
}

// Every segment takes its most similar name. It counts only with a high score and a clear lead, and when the names
// belong to one airing of the same size in the same order.
function byFuzzy(file: FileEvidence, context: Context) {
  const segments = segmentsOf(file.title);
  if (!segments.length) return;
  const best: CatalogEpisode[] = [];
  for (const segment of segments) {
    const name = normalizeTitle(segment);
    const scored = context.episodes
      .filter((episode) => episode.season > 0)
      .map((episode) => ({ episode, score: similarity(name, context.normalized.get(episode)!) }))
      .sort((a, b) => b.score - a.score);
    const first = scored[0];
    const second = scored.find((item) => context.normalized.get(item.episode) !== context.normalized.get(first!.episode));
    if (!first || first.score < 0.9) return;
    if (second && first.score - second.score < 0.1) return;
    best.push(first.episode);
  }
  const index = context.airingOf.get(best[0]!);
  const airing = index === undefined ? undefined : context.airings[index]!;
  if (!airing || airing.length !== best.length) return;
  if (!airing.every((episode, at) => episode === best[at])) return;
  return fits(airing, file.durationSeconds) ? airing : undefined;
}

// The numbering of the release, only when nothing else identified the file. A file with several segments can not be
// one episode, so this step needs a title of one segment or no title at all.
function byReleaseNumber(file: FileEvidence, context: Context) {
  if (segmentsOf(file.title).length > 1) return;
  if (file.season === null || file.episode === null) return;
  return context.byPosition.get(`${file.season}x${file.episode}`);
}

export function matchContent(files: FileEvidence[], episodes: CatalogEpisode[]): ContentMatch {
  const context = contextOf(episodes);
  const claimed = new Set<string>();
  const used = new Set<number>();
  const answers = new Map<string, ContentProposal>();
  const rejected = new Map<string, ContentRejection>();

  const propose = (file: FileEvidence, list: CatalogEpisode[], step: ContentStep, evidence: string) => {
    for (const episode of list) {
      claimed.add(position(episode));
      const index = context.airingOf.get(episode);
      if (index !== undefined) used.add(index);
    }
    answers.set(file.path, { path: file.path, episodes: list.map((episode) => ({ season: episode.season, number: episode.number })), step, evidence });
  };
  const reject = (file: FileEvidence, reason: ContentRejection['reason'], evidence: string) => rejected.set(file.path, { path: file.path, reason, evidence });

  // The steps that read one file alone. Two of them with different airings is a contradiction, and a person decides.
  for (const file of files) {
    const whole = byWholeTitle(file, context);
    const segments = bySegments(file, context);
    const anchor = byAnchor(file, context);
    if (anchor && 'conflict' in anchor) {
      reject(file, 'conflict', `title "${file.title}" names segments of more than one airing`);
      continue;
    }
    const found = [whole, segments, anchor?.airing].filter((airing): airing is Airing => Boolean(airing));
    const distinct = new Set(found);
    if (distinct.size > 1) {
      reject(file, 'conflict', `title "${file.title}" gives more than one airing`);
      continue;
    }
    const airing = found[0];
    if (!airing) continue;
    const step: ContentStep = airing === whole ? 'whole_title' : airing === segments ? 'segments' : 'anchor';
    propose(file, airing, step, describe(airing));
  }

  // The files that stay take the airings that no other file took. This counts only when one solution remains after
  // the airings that only one file can take leave the candidates of the other files.
  const pending = files.filter((file) => !answers.has(file.path) && !rejected.has(file.path));
  const candidates = new Map<string, number[]>();
  for (const file of pending) {
    const count = segmentsOf(file.title).length;
    const free = context.airings.flatMap((airing, index) => (!used.has(index) && airing.length === count && fits(airing, file.durationSeconds) ? [index] : []));
    candidates.set(file.path, free);
  }
  let assigned = true;
  while (assigned) {
    assigned = false;
    for (const [path, free] of candidates) {
      if (free.length !== 1) continue;
      const index = free[0]!;
      candidates.delete(path);
      used.add(index);
      const file = pending.find((item) => item.path === path)!;
      propose(file, context.airings[index]!, 'global', describe(context.airings[index]!));
      for (const other of candidates.values()) {
        const at = other.indexOf(index);
        if (at >= 0) other.splice(at, 1);
      }
      assigned = true;
    }
  }

  // A file that the names only describe with small differences takes its most similar names.
  const left = files.filter((file) => !answers.has(file.path) && !rejected.has(file.path));
  for (const file of left) {
    const airing = byFuzzy(file, context);
    if (airing) propose(file, airing, 'fuzzy', describe(airing));
  }

  // The numbering of the release. It is the last choice, and only for what no other step could read.
  for (const file of files) {
    if (answers.has(file.path) || rejected.has(file.path)) continue;
    const episode = byReleaseNumber(file, context);
    if (!episode) continue;
    if (claimed.has(position(episode))) {
      reject(file, 'conflict', `S${episode.season}E${episode.number} is already part of another file`);
      continue;
    }
    propose(file, [episode], 'release_number', `${describe([episode])} from the release numbering ${file.season}x${file.episode}`);
  }

  // What no step read stays for a person. More than one possible airing is not the same problem as no airing.
  for (const file of files) {
    if (answers.has(file.path) || rejected.has(file.path)) continue;
    const possible = candidates.get(file.path) ?? [];
    if (possible.length > 1) reject(file, 'ambiguous', `${possible.length} airings of ${segmentsOf(file.title).length} episodes fit`);
    else reject(file, 'no_match', `no step matched the title "${file.title ?? ''}"`);
  }

  return {
    proposals: files.flatMap((file) => answers.get(file.path) ?? []),
    rejections: files.flatMap((file) => rejected.get(file.path) ?? []),
  };
}
