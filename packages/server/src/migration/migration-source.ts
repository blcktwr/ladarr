import { createHash } from 'node:crypto';
import type { ImportNote, MediaType } from '@ladarr/shared/enums';
import { outboundFetch } from '../core/http.ts';

export type SourceApp = 'sonarr' | 'radarr';

// The majors of Sonarr and Radarr that the import reads. Their API contract is the one in the official OpenAPI files.
export const SUPPORTED_MAJORS: Record<SourceApp, number[]> = { sonarr: [4], radarr: [5, 6] };

export class SourceError extends Error {
  code:
    | 'source_url_invalid'
    | 'source_unreachable'
    | 'source_key_rejected'
    | 'source_wrong_app'
    | 'source_version_unsupported'
    | 'source_invalid_response'
    | 'backup_invalid'
    | 'backup_unsupported'
    | 'backup_unsafe'
    | 'backup_too_large'
    | 'backup_no_database'
    | 'backup_database_invalid';
  detail?: string;
  constructor(code: SourceError['code'], detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

type SourceQuality = { id?: number; name?: string; source?: string; resolution?: number };
type ProfileItem = { id?: number; name?: string; quality?: SourceQuality; items?: ProfileItem[]; allowed?: boolean };

export type SourceProfile = {
  id: number;
  name: string;
  cutoff: number;
  items: ProfileItem[];
  minFormatScore: number;
  formatItems: { score?: number }[];
  language: string | null;
};

export type SourceEpisode = { season: number; number: number; monitored: boolean; airDateUtc: string | null };

// One download hash and the episodes or the movie that it covers. The backup records it; the torrent is optional.
export type SourceDownload = { hash: string; episodes: { season: number; number: number }[]; at: number; id: number; failed: boolean };

export type SourceTitle = {
  sourceId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  path: string | null;
  monitored: boolean;
  qualityProfileId: number;
  seriesType: 'standard' | 'daily' | 'anime';
  seasons: { seasonNumber: number; monitored: boolean }[];
  minimumAvailability: string | null;
  // The episodes of the series, and the hashes that the source recorded for it.
  episodes?: SourceEpisode[];
  downloads?: SourceDownload[];
};

export type SourceData = {
  app: SourceApp;
  version: string;
  // Source IDs are only unique inside one source, so each ledger key starts with this.
  namespace: string;
  titles: SourceTitle[];
  profiles: SourceProfile[];
};

// ---- reading a running instance ----

type Options = { url: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number };

export const int = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null);
export const str = (value: unknown) => (typeof value === 'string' ? value : null);
export const arr = (value: unknown): any[] => (Array.isArray(value) ? value : []);

export function parseBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SourceError('source_url_invalid');
  }
  // The key goes in a header, so the address must not hold credentials.
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) throw new SourceError('source_url_invalid');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function connect({ url, apiKey, fetch: fetchImpl = fetch, timeoutMs = 20_000 }: Options) {
  const base = parseBaseUrl(url);
  const send = outboundFetch('Migration source', fetchImpl);

  async function get(path: string): Promise<unknown> {
    let res: Response;
    try {
      // A redirect would send the key to another address, so the code does not follow it.
      res = await send(new URL(path, base), { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new SourceError('source_unreachable');
    }
    if (res.status === 401 || res.status === 403) throw new SourceError('source_key_rejected');
    if (!res.ok) throw new SourceError('source_unreachable', `HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new SourceError('source_invalid_response');
    }
  }

  const status = (await get('api/v3/system/status')) as Record<string, unknown>;
  const app = str(status?.appName)?.toLowerCase();
  if (app !== 'sonarr' && app !== 'radarr') throw new SourceError('source_wrong_app', str(status?.appName) ?? undefined);
  const version = str(status.version) ?? '';
  const major = Number(version.split('.')[0]);
  if (!SUPPORTED_MAJORS[app].includes(major)) throw new SourceError('source_version_unsupported', version);
  return { get, base, app: app as SourceApp, version };
}

// Shows that the address and the key work, and that the version is one that the import reads.
export async function testConnection(options: Options) {
  const { app, version } = await connect(options);
  return { app, version };
}

export async function readFromApi(options: Options): Promise<SourceData> {
  const { get, base, app, version } = await connect(options);

  const [list, profiles] = await Promise.all([get(app === 'sonarr' ? 'api/v3/series' : 'api/v3/movie'), get('api/v3/qualityprofile')]);
  if (!Array.isArray(list) || !Array.isArray(profiles)) throw new SourceError('source_invalid_response');

  const namespace = `${app}:${createHash('sha256').update(`${base.origin}${base.pathname}`).digest('hex').slice(0, 8)}`;
  return {
    app,
    version,
    namespace,
    titles: list.flatMap((item): SourceTitle[] => {
      const id = int(item?.id);
      if (id === null) return [];
      const tmdbId = int(item.tmdbId);
      const tvdbId = int(item.tvdbId);
      return [
        {
          sourceId: id,
          mediaType: app === 'sonarr' ? 'tv' : 'movie',
          title: str(item.title) ?? '',
          year: int(item.year) || null,
          // The API sends 0 for an ID that the source does not know.
          tmdbId: tmdbId || null,
          tvdbId: tvdbId || null,
          path: str(item.path),
          monitored: item.monitored === true,
          qualityProfileId: int(item.qualityProfileId) ?? 0,
          seriesType: item.seriesType === 'anime' || item.seriesType === 'daily' ? item.seriesType : 'standard',
          seasons: arr(item.seasons).flatMap((season) => (int(season?.seasonNumber) === null ? [] : [{ seasonNumber: season.seasonNumber, monitored: season.monitored === true }])),
          minimumAvailability: str(item.minimumAvailability),
        },
      ];
    }),
    profiles: profiles.flatMap((profile): SourceProfile[] => {
      const id = int(profile?.id);
      if (id === null) return [];
      const language = str(profile.language?.name);
      return [
        {
          id,
          name: str(profile.name) ?? `Profile ${id}`,
          cutoff: int(profile.cutoff) ?? -1,
          items: arr(profile.items),
          minFormatScore: int(profile.minFormatScore) ?? 0,
          formatItems: arr(profile.formatItems),
          language: language && language !== 'Any' ? language : null,
        },
      ];
    }),
  };
}

// ---- quality profiles ----

export type ProfileNote = Extract<ImportNote, 'resolution_not_supported' | 'several_resolutions' | 'sources_not_supported' | 'custom_formats' | 'language_preference'>;

// Sonarr and Radarr name the sources in other words.
const SOURCE: Record<string, 'webdl' | 'webrip' | 'bluray'> = {
  web: 'webdl',
  webdl: 'webdl',
  webrip: 'webrip',
  bluray: 'bluray',
  blurayraw: 'bluray',
};

type Leaf = { quality: SourceQuality; allowed: boolean; id: number | undefined };

function leaves(items: ProfileItem[], inherited = false): Leaf[] {
  return items.flatMap((item) => {
    const allowed = inherited || item.allowed === true;
    if (item.items?.length) return leaves(item.items, allowed);
    return item.quality ? [{ quality: item.quality, allowed, id: item.quality.id }] : [];
  });
}

// Maps a profile to the closest ladarr preset. ladarr has one resolution for each preset, so the
// code takes the resolution that the cutoff names. Every setting that ladarr cannot keep becomes a note.
export function mapProfile(profile: SourceProfile): { preset: string | null; notes: ProfileNote[] } {
  const notes: ProfileNote[] = [];
  const allowed = leaves(profile.items).filter((leaf) => leaf.allowed);
  const supported = allowed.filter((leaf) => SOURCE[String(leaf.quality.source).toLowerCase()]);
  if (allowed.length > supported.length) notes.push('sources_not_supported');

  const resolutions = [...new Set(supported.map((leaf) => leaf.quality.resolution ?? 0))].filter((r) => r >= 1080).sort((a, b) => a - b);
  if (resolutions.length > 1) notes.push('several_resolutions');

  // The cutoff is the id of a quality, or of a group of qualities.
  let target: number | undefined;
  const cutoffItem = profile.items.find((item) => item.id === profile.cutoff || item.quality?.id === profile.cutoff);
  // A cutoff that the profile does not allow names no goal, so the highest allowed quality stands in.
  if (cutoffItem?.allowed) {
    const found = leaves([cutoffItem], true).map((leaf) => leaf.quality.resolution ?? 0);
    if (found.length) target = Math.max(...found);
  }
  target ??= supported.length ? Math.max(...supported.map((leaf) => leaf.quality.resolution ?? 0)) : undefined;

  let preset: string | null = null;
  if (target !== undefined && target >= 2160) preset = 'p2160';
  else if (target !== undefined && target >= 1080) preset = 'p1080';
  else notes.push('resolution_not_supported');

  if (profile.minFormatScore !== 0 || profile.formatItems.some((format) => (format.score ?? 0) !== 0)) notes.push('custom_formats');
  if (profile.language) notes.push('language_preference');
  return { preset, notes };
}

// ---- paths ----

export type PathMapping = { from: string; to: string };

// A Windows path becomes a path with slashes, so one mapping rule covers both.
const toSlashes = (path: string) => (/^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') ? path.replace(/\\/g, '/') : path);
const trimEnd = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

// Applies the rule with the longest matching start. A rule matches whole path parts only.
export function mapPath(path: string, mappings: PathMapping[]): string {
  const source = trimEnd(toSlashes(path));
  const rules = mappings
    .map((rule) => ({ from: trimEnd(toSlashes(rule.from)), to: trimEnd(rule.to) }))
    // The match ignores case, because a Windows source does.
    .filter((rule) => rule.from !== '' && (source.toLowerCase() === rule.from.toLowerCase() || source.toLowerCase().startsWith(`${rule.from.toLowerCase()}/`)))
    .sort((a, b) => b.from.length - a.from.length);
  const rule = rules[0];
  return rule ? `${rule.to}${source.slice(rule.from.length)}` : source;
}
