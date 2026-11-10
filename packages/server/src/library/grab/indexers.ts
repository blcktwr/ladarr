import type { IndexerApp, IndexerNotUsed as NotUsed, MediaType } from '@ladarr/shared/enums';
import type { IndexerHealth, IndexerRow } from '@ladarr/shared/types';
import { type Db, db } from '../../core/db.ts';

export type { IndexerApp, NotUsed };
export const APP_MEDIA: Record<IndexerApp, MediaType> = { sonarr: 'tv', radarr: 'movie' };

// What the indexer manager pushed for one app. The indexer manager owns these values. ladarr only reads them.
export type IndexerPush = {
  name: string;
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  priority: number;
  categories: number[];
  animeCategories: number[];
  minimumSeeders: number;
  tags: number[];
  // The ID of a download client of the app. Null or 0 means the default client. Old records lack it.
  downloadClientId?: number | null;
  // The other schema fields, as the indexer manager sent them. ladarr sends them back unchanged, so the indexer manager sees no difference.
  fields: Record<string, unknown>;
};

export type Protocol = 'torrent' | 'usenet';

// The search modes of the indexer. Each mode lists the query parameters that it accepts, or is null when it is not available.
export type Caps = { search: string[] | null; tv: string[] | null; movie: string[] | null; categories: number[] };

export type Indexer = {
  id: number;
  baseUrl: string;
  apiPath: string;
  apiKey: string;
  // The delay and the preferred languages are the fields that ladarr owns.
  // The least time, in seconds, between two requests that start.
  delaySeconds: number;
  // The languages of the names that the indexer should receive. No languages means every language.
  preferredLanguages?: string[];
  // The limiter keeps this time in the database, so a restart does not shorten the delay.
  nextRequestAt: number;
  push: Partial<Record<IndexerApp, IndexerPush>>;
  // Old records lack it. They are torrent indexers.
  protocol?: Protocol;
  // The user added the indexer in Settings. The indexer manager did not push it, so the user can change all of its fields.
  manual?: true;
  caps: Caps | null;
  capsAt: number;
  health: IndexerHealth;
};

export const DEFAULT_DELAY_SECONDS = 6;
export const MAX_DELAY_SECONDS = 3600;
export const MASK = '********';

export const indexerName = (indexer: Indexer) => (indexer.push.sonarr ?? indexer.push.radarr)?.name ?? `Indexer ${indexer.id}`;

type Field = { order: number; name: string; label: string; type: string; advanced: boolean; privacy: string; default: unknown };
const field = (order: number, name: string, type: string, def: unknown, extra: Partial<Field> = {}): Field => ({
  order,
  name,
  label: name,
  type,
  advanced: false,
  privacy: 'normal',
  default: def,
  ...extra,
});

const SEED_FIELDS = [field(7, 'seedCriteria.seedRatio', 'number', null, { advanced: true }), field(8, 'seedCriteria.seedTime', 'number', null, { advanced: true })];
const COMMON = [
  field(0, 'baseUrl', 'textbox', ''),
  field(1, 'apiPath', 'textbox', '/api', { advanced: true }),
  field(2, 'apiKey', 'textbox', '', { privacy: 'apiKey' }),
  field(3, 'categories', 'select', [], {}),
  field(6, 'minimumSeeders', 'number', 1, { advanced: true }),
  ...SEED_FIELDS,
  field(10, 'rejectBlocklistedTorrentHashesWhileGrabbing', 'checkbox', false, { advanced: true }),
  field(11, 'additionalParameters', 'textbox', null, { advanced: true }),
];
export const SCHEMA_FIELDS: Record<IndexerApp, Field[]> = {
  sonarr: [
    ...COMMON,
    field(4, 'animeCategories', 'select', []),
    field(5, 'animeStandardFormatSearch', 'checkbox', false, { advanced: true }),
    field(9, 'seedCriteria.seasonPackSeedTime', 'number', null, { advanced: true }),
  ],
  radarr: [...COMMON, field(12, 'multiLanguages', 'select', []), field(13, 'removeYear', 'checkbox', false, { advanced: true }), field(14, 'requiredFlags', 'select', [], { advanced: true })],
};

export const IMPLEMENTATIONS = ['Newznab', 'Torznab'] as const;
const PROTOCOL: Record<(typeof IMPLEMENTATIONS)[number], Protocol> = { Newznab: 'usenet', Torznab: 'torrent' };

// Why ladarr does not use an indexer for an app. ladarr has no Usenet client, no tags on titles, and one download client.
export function notUsedReason(indexer: Indexer, app: IndexerApp): NotUsed | null {
  const push = indexer.push[app];
  if (!push) return null;
  if (indexer.protocol === 'usenet') return 'usenet';
  // In Sonarr and Radarr, a tag limits an indexer to the titles with the same tag. A title of ladarr has no tag.
  if (push.tags.length) return 'tags';
  // The one download client of ladarr has no ID, so an ID other than 0 names a client that ladarr does not have.
  if (push.downloadClientId) return 'download_client';
  return null;
}

// The share limits that the indexer asks for. The indexer manager sends the time in minutes, like qBittorrent.
export type SeedLimits = { ratio: number | null; minutes: number | null };

export function seedLimits(indexer: Indexer, app: IndexerApp, pack: boolean): SeedLimits | null {
  const fields = indexer.push[app]?.fields ?? {};
  const positive = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
  const ratio = positive(fields['seedCriteria.seedRatio']);
  const minutes = positive((pack ? fields['seedCriteria.seasonPackSeedTime'] : undefined) ?? fields['seedCriteria.seedTime']);
  return ratio === null && minutes === null ? null : { ratio, minutes };
}

type Rejected = { propertyName: string; errorMessage: string; severity: 'error' }[];
export const invalid = (propertyName: string, errorMessage: string): { errors: Rejected } => ({ errors: [{ propertyName, errorMessage, severity: 'error' }] });

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCategoryList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length <= 500 && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 999_999);
export const isLanguageList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 20 && value.every((code) => typeof code === 'string' && /^[a-z]{2,3}$/.test(code));

export type Parsed = { baseUrl: string; apiPath: string; apiKey: string | null; protocol: Protocol; push: IndexerPush };

// Reads the body of a push. The body comes from outside, so every value is checked.
export function parsePush(app: IndexerApp, body: unknown): Parsed | { errors: Rejected } {
  if (!isObject(body)) return invalid('', 'The body must be an object.');
  // A Newznab indexer is stored and flagged, so the list can say that ladarr does not use it.
  const implementation = IMPLEMENTATIONS.find((name) => name === body.implementation);
  if (!implementation) return invalid('implementation', 'The implementation must be Torznab or Newznab.');
  if (!Array.isArray(body.fields)) return invalid('fields', 'The fields must be a list.');

  const values: Record<string, unknown> = {};
  for (const item of body.fields) if (isObject(item) && typeof item.name === 'string') values[item.name] = item.value;

  const text = (name: string) => (typeof values[name] === 'string' ? (values[name] as string) : '');
  let url: URL;
  try {
    url = new URL(text('baseUrl'));
  } catch {
    return invalid('baseUrl', 'The address is not valid.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return invalid('baseUrl', 'The address must be an http or https address with no credentials, query, or fragment.');
  }
  const apiPath = text('apiPath') || '/api';
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(apiPath)) return invalid('apiPath', 'The API path is not valid.');
  const apiKey = text('apiKey');
  if (apiKey.length > 200) return invalid('apiKey', 'The API key is too long.');

  const categories = values.categories ?? [];
  const animeCategories = values.animeCategories ?? [];
  if (!isCategoryList(categories)) return invalid('categories', 'The categories must be a list of numbers.');
  if (!isCategoryList(animeCategories)) return invalid('animeCategories', 'The anime categories must be a list of numbers.');
  const minimumSeeders = values.minimumSeeders ?? 1;
  if (!Number.isInteger(minimumSeeders) || (minimumSeeders as number) < 0 || (minimumSeeders as number) > 10_000) return invalid('minimumSeeders', 'The minimum seeders must be a whole number.');
  if (typeof body.name !== 'string' || !body.name || body.name.length > 200) return invalid('name', 'The name is not valid.');
  if (!Number.isInteger(body.priority ?? 25) || (body.priority as number) < 1 || (body.priority as number) > 50) return invalid('priority', 'The priority must be from 1 to 50.');
  const tags = body.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((tag) => Number.isInteger(tag))) return invalid('tags', 'The tags must be a list of numbers.');
  const downloadClientId = body.downloadClientId ?? 0;
  if (!Number.isInteger(downloadClientId) || (downloadClientId as number) < 0) return invalid('downloadClientId', 'The download client ID must be a whole number.');

  const known = new Set(['baseUrl', 'apiPath', 'apiKey', 'categories', 'animeCategories', 'minimumSeeders']);
  const allowed = new Set(SCHEMA_FIELDS[app].map((item) => item.name));
  const fields = Object.fromEntries(Object.entries(values).filter(([name]) => allowed.has(name) && !known.has(name)));
  const flag = (name: string) => body[name] !== false;
  const origin = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return {
    baseUrl: `${origin}/`,
    apiPath,
    apiKey: apiKey && apiKey !== MASK ? apiKey : null,
    protocol: PROTOCOL[implementation],
    push: {
      name: body.name,
      enableRss: flag('enableRss'),
      enableAutomaticSearch: flag('enableAutomaticSearch'),
      enableInteractiveSearch: flag('enableInteractiveSearch'),
      priority: (body.priority as number | undefined) ?? 25,
      categories,
      animeCategories,
      minimumSeeders: minimumSeeders as number,
      tags: tags as number[],
      downloadClientId: downloadClientId as number,
      fields,
    },
  };
}

export const identity = (baseUrl: string, apiPath: string) => `${baseUrl.replace(/\/+$/, '')}${apiPath}`.toLowerCase();

export const newHealth = (): IndexerHealth => ({ okAt: null, failedAt: null, failures: 0, retryAt: 0, error: null });

// One indexer record serves both apps. The indexer manager pushes the same indexer to Sonarr and to Radarr.
// A push of the same address changes the record. It never makes a second one.
export function savePush(app: IndexerApp, parsed: Parsed, id?: number): Indexer | undefined {
  const { indexers } = db.data;
  const wanted = identity(parsed.baseUrl, parsed.apiPath);
  const existing = id === undefined ? Object.values(indexers).find((item) => identity(item.baseUrl, item.apiPath) === wanted) : indexers[id];
  if (id !== undefined && !existing?.push[app]) return;
  if (!parsed.apiKey && !existing) return;

  const indexer: Indexer =
    existing ??
    (indexers[++db.data.indexerSeq] = {
      id: db.data.indexerSeq,
      baseUrl: parsed.baseUrl,
      apiPath: parsed.apiPath,
      apiKey: parsed.apiKey!,
      delaySeconds: DEFAULT_DELAY_SECONDS,
      preferredLanguages: [],
      nextRequestAt: 0,
      push: {},
      caps: null,
      capsAt: 0,
      health: newHealth(),
    });
  if (existing) {
    // The address or the key changed in the indexer manager. The old caps and health no longer apply.
    if (identity(existing.baseUrl, existing.apiPath) !== wanted || (parsed.apiKey && parsed.apiKey !== existing.apiKey)) {
      existing.caps = null;
      existing.capsAt = 0;
      existing.health = newHealth();
    }
    existing.baseUrl = parsed.baseUrl;
    existing.apiPath = parsed.apiPath;
    if (parsed.apiKey) existing.apiKey = parsed.apiKey;
  }
  indexer.push[app] = parsed.push;
  indexer.protocol = parsed.protocol;
  // A push gives the fields to the indexer manager.
  delete indexer.manual;
  return indexer;
}

export function removePush(app: IndexerApp, id: number) {
  const indexer = db.data.indexers[id];
  if (!indexer?.push[app]) return false;
  delete indexer.push[app];
  if (!indexer.push.sonarr && !indexer.push.radarr) delete db.data.indexers[id];
  return true;
}

// The indexers that can serve a media type: the indexer manager pushed them to the matching app.
export function indexersFor(mediaType: MediaType) {
  const app: IndexerApp = mediaType === 'movie' ? 'radarr' : 'sonarr';
  return Object.values(db.data.indexers).filter((indexer) => indexer.push[app]);
}

export function summarize(indexer: Indexer): IndexerRow {
  const pushes = Object.values(indexer.push);
  return {
    id: indexer.id,
    name: indexerName(indexer),
    type: indexer.protocol === 'usenet' ? 'newznab' : 'torznab',
    manual: Boolean(indexer.manual),
    baseUrl: indexer.baseUrl,
    apps: (Object.keys(indexer.push) as IndexerApp[]).sort(),
    priority: Math.min(...pushes.map((push) => push.priority)),
    delaySeconds: indexer.delaySeconds,
    preferredLanguages: indexer.preferredLanguages ?? [],
    nextRequestAt: indexer.nextRequestAt,
    enableRss: pushes.some((push) => push.enableRss),
    enableAutomaticSearch: pushes.some((push) => push.enableAutomaticSearch),
    enableInteractiveSearch: pushes.some((push) => push.enableInteractiveSearch),
    health: indexer.health,
    notUsed: (Object.keys(indexer.push) as IndexerApp[]).sort().flatMap((app) => {
      const reason = notUsedReason(indexer, app);
      return reason ? [{ app, reason }] : [];
    }),
  };
}

