import type { QualityProfile, SizeLimits } from '@ladarr/shared/types';

// Version 4 of the quality table. Change the version when a number of the table or the list of qualities changes.
// docs/quality-presets.md explains the rules.
export const QUALITY_TABLE_VERSION = 4;

export type Source = 'webdl' | 'webrip' | 'bluray' | 'remux' | 'rawhd' | 'hdtv' | 'sdtv' | 'dvd';
export type ReleaseSource = Source | 'cam' | 'telesync' | 'unknown';

export type { SizeLimits };

// A quality is a source with a resolution. A DVD has no resolution.
export type Quality = { id: string; label: string; source: Source; resolution: number | null };

const SOURCE_LABEL: Record<Source, string> = { webdl: 'WEB-DL', webrip: 'WEBRip', bluray: 'BluRay', remux: 'BluRay Remux', rawhd: 'Raw-HD', hdtv: 'HDTV', sdtv: 'SDTV', dvd: 'DVD' };
const RESOLUTIONS = [480, 720, 1080, 2160];

const qualitiesOf = (source: Source, resolutions: number[]): Quality[] =>
  resolutions.map((resolution) => ({ id: `${source}-${resolution}`, label: `${SOURCE_LABEL[source]} ${resolution}p`, source, resolution }));

// The lowest quality first. The list is the one of Sonarr, with DVD at the bottom.
export const QUALITIES: Quality[] = [
  { id: 'dvd', label: 'DVD', source: 'dvd', resolution: null },
  ...qualitiesOf('sdtv', [480]),
  ...qualitiesOf('hdtv', [720, 1080, 2160]),
  ...qualitiesOf('rawhd', [1080]),
  ...qualitiesOf('webdl', RESOLUTIONS),
  ...qualitiesOf('webrip', RESOLUTIONS),
  ...qualitiesOf('bluray', [480, 576, 720, 1080, 2160]),
  ...qualitiesOf('remux', [1080, 2160]),
];
const QUALITY_IDS = new Set(QUALITIES.map((quality) => quality.id));
export const isQualityId = (value: unknown): value is string => typeof value === 'string' && QUALITY_IDS.has(value);

// The resolution of a quality. DVD has none.
export const qualityResolution = (id: string) => QUALITIES.find((quality) => quality.id === id)?.resolution ?? null;

// The minimums of the standard size table of TRaSH Guides for a series. The table sets no maximum, so a quality has
// none either. A quality that is not here, such as Raw-HD, has no limit until the user sets one.
const MINIMUMS: Record<string, number> = {
  dvd: 5,
  'sdtv-480': 5,
  'hdtv-720': 17.1,
  'hdtv-1080': 33.8,
  'hdtv-2160': 85,
  'webdl-480': 5,
  'webdl-720': 12.5,
  'webdl-1080': 12.5,
  'webdl-2160': 34.5,
  'webrip-480': 5,
  'webrip-720': 12.5,
  'webrip-1080': 12.5,
  'webrip-2160': 34.5,
  'bluray-480': 5,
  'bluray-576': 5,
  'bluray-720': 25.7,
  'bluray-1080': 50.8,
  'bluray-2160': 102,
  'remux-1080': 102,
  'remux-2160': 187.4,
};
export const defaultSizes = (): Record<string, SizeLimits> => Object.fromEntries(QUALITIES.map(({ id }) => [id, { min: MINIMUMS[id] ?? null, preferred: null, max: null }]));

// A movie has no size check until the user sets one.
export const unlimitedSizes = (): Record<string, SizeLimits> => Object.fromEntries(QUALITIES.map(({ id }) => [id, { min: null, preferred: null, max: null }]));

// A profile lists the qualities that ladarr takes, the best first. The qualities of one group have the same rank.
// A quality that is in no group is not taken.
export type Profile = QualityProfile;

// The profiles of version 1 of the table.
export function defaultProfiles(): Record<string, Profile> {
  const profile = (resolution: number): Profile => ({
    id: `p${resolution}`,
    name: `${resolution}p`,
    items: [[`webdl-${resolution}`], [`webrip-${resolution}`], [`bluray-${resolution}`]],
  });
  return { p1080: profile(1080), p2160: profile(2160) };
}

// The rank of a quality in a profile. A lower rank is better. -1 means that the profile does not take it.
export const rankOf = (profile: Profile, quality: string) => profile.items.findIndex((group) => group.includes(quality));

// The rank of a profile in the chain. A group of a lower profile is worse than every group of a higher one.
export const RANK_STRIDE = 1000;

// The name of a quality for a person. A release whose source or resolution is off the table keeps both words.
export const qualityLabel = (source: ReleaseSource, resolution: number | null) => {
  const id = qualityOf(source, resolution);
  if (id) return QUALITIES.find((item) => item.id === id)?.label ?? id;
  const words = source === 'unknown' ? 'unknown source' : source;
  return resolution === null ? words : `${words} ${resolution}p`;
};

// The profile as a person reads it: its name and the qualities that it takes.
export function explainProfile(profile: Profile) {
  const labelOf = (id: string) => QUALITIES.find((item) => item.id === id)?.label ?? id;
  return {
    id: profile.id,
    name: profile.name,
    // One group is one rank. The qualities of a group are equal choices.
    qualities: profile.items.map((group) => group.map(labelOf).join(' = ')),
  };
}

const QUALITY_BY_SOURCE_RESOLUTION = new Map(QUALITIES.map((quality) => [`${quality.source}:${quality.resolution}`, quality.id]));

// The quality of a release, or null when its source or its resolution is not on the list.
export function qualityOf(source: ReleaseSource, resolution: number | null): string | null {
  if (source === 'dvd') return 'dvd';
  if (resolution === null) return null;
  return QUALITY_BY_SOURCE_RESOLUTION.get(`${source}:${resolution}`) ?? null;
}

// The rank of a file in a profile. A file with a known source and no resolution gets the best rank of that source in the profile.
// A file that the profile does not take is worse than all the groups. Null: the source of the file is not known.
export function fileRank(profile: Profile, source: ReleaseSource, resolution: number | null): number | null {
  if (source === 'unknown') return null;
  const quality = qualityOf(source, resolution);
  if (quality) {
    const rank = rankOf(profile, quality);
    return rank >= 0 ? rank : profile.items.length;
  }
  const ranks = QUALITIES.filter((candidate) => candidate.source === source && rankOf(profile, candidate.id) >= 0).map((candidate) => rankOf(profile, candidate.id));
  return ranks.length ? Math.min(...ranks) : profile.items.length;
}

// The rank of a file in the chain. The first profile that takes the file quality gives the rank.
// A file that no profile takes is worse than the whole chain. Null: the source of the file is not known.
export function chainFileRank(profiles: Profile[], source: ReleaseSource, resolution: number | null): { rank: number; profileIndex: number | null } | null {
  if (source === 'unknown') return null;
  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index]!;
    const rank = fileRank(profile, source, resolution);
    if (rank !== null && rank < profile.items.length) return { rank: index * RANK_STRIDE + rank, profileIndex: index };
  }
  return { rank: profiles.length * RANK_STRIDE, profileIndex: null };
}

export type Release = {
  source: ReleaseSource;
  resolution: number | null;
  sizeBytes: number;
  // Null when the release does not say which audio it has.
  audioLanguages: string[] | null;
};

export type Rejection = 'quality_rejected' | 'quality_not_in_profile' | 'size_below_min' | 'size_above_max' | 'audio_unverified' | 'audio_language_missing';

export type Evaluation = {
  accepted: boolean;
  rejections: Rejection[];
  // A check that could not run, so the user sees the constraint that is missing.
  unchecked: 'size'[];
  // Lower is better. Null when the profile does not take the release.
  rank: number | null;
  mibPerMinute: number | null;
  limits: SizeLimits | null;
};

const MIB = 1024 * 1024;
const NEVER_AUTOMATIC: ReleaseSource[] = ['cam', 'telesync', 'unknown'];

// runtimeMinutes is the runtime that the release covers: a movie, an episode, or the sum of a pack.
export function evaluate(
  profile: Profile,
  sizes: Record<string, SizeLimits>,
  release: Release,
  { runtimeMinutes, audio }: { runtimeMinutes: number | null; audio?: { language: string; strict: boolean } | null },
): Evaluation {
  const rejections: Rejection[] = [];
  const unchecked: Evaluation['unchecked'] = [];
  const quality = qualityOf(release.source, release.resolution);
  const rank = quality ? rankOf(profile, quality) : -1;
  const taken = rank >= 0;
  const limits = taken ? (sizes[quality!] ?? null) : null;

  if (NEVER_AUTOMATIC.includes(release.source)) rejections.push('quality_rejected');
  else if (!taken) rejections.push('quality_not_in_profile');

  let mibPerMinute: number | null = null;
  if (runtimeMinutes && runtimeMinutes > 0) {
    mibPerMinute = release.sizeBytes / MIB / runtimeMinutes;
    if (limits) {
      if (limits.min !== null && mibPerMinute < limits.min) rejections.push('size_below_min');
      if (limits.max !== null && mibPerMinute > limits.max) rejections.push('size_above_max');
    }
  } else {
    // An unknown runtime gives no size limit. The check is skipped, not guessed.
    unchecked.push('size');
  }

  if (audio?.strict) {
    if (release.audioLanguages === null) rejections.push('audio_unverified');
    else if (!release.audioLanguages.includes(audio.language)) rejections.push('audio_language_missing');
  }

  return { accepted: rejections.length === 0, rejections, unchecked, rank: taken ? rank : null, mibPerMinute, limits };
}

const NO_PROFILE: Profile = { id: '', name: '', items: [] };

// The chain of a title, the best profile first. The first profile that takes the release quality decides it.
// A quality that no profile takes is rejected with the reason of the first profile.
export function evaluateChain(
  profiles: Profile[],
  sizes: Record<string, SizeLimits>,
  release: Release,
  { runtimeMinutes, audio }: { runtimeMinutes: number | null; audio?: { language: string; strict: boolean } | null },
): Evaluation & { profile: Profile | null } {
  const quality = qualityOf(release.source, release.resolution);
  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index]!;
    const rank = quality ? rankOf(profile, quality) : -1;
    if (rank < 0) continue;
    return { ...evaluate(profile, sizes, release, { runtimeMinutes, audio }), rank: index * RANK_STRIDE + rank, profile };
  }
  return { ...evaluate(profiles[0] ?? NO_PROFILE, sizes, release, { runtimeMinutes, audio }), rank: null, profile: null };
}
