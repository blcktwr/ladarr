import type { IndexerApp, IndexerNotUsed as NotUsed, MediaType } from '@ladarr/shared/enums';
import type { IndexerHealth, IndexerRow, IndexerTestResult } from '@ladarr/shared/types';
import { Router, type RequestHandler, type Response } from 'express';
import type { Db } from '../core/db.ts';
import { IndexerError, type IndexerService } from './torznab.ts';

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
const MASK = '********';
// The version that ladarr reports to the indexer manager. The indexer manager needs 3.0.5.0 or later.
const VERSION: Record<IndexerApp, string> = { sonarr: '4.0.0.0', radarr: '5.0.0.0' };

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
const SCHEMA_FIELDS: Record<IndexerApp, Field[]> = {
  sonarr: [
    ...COMMON,
    field(4, 'animeCategories', 'select', []),
    field(5, 'animeStandardFormatSearch', 'checkbox', false, { advanced: true }),
    field(9, 'seedCriteria.seasonPackSeedTime', 'number', null, { advanced: true }),
  ],
  radarr: [...COMMON, field(12, 'multiLanguages', 'select', []), field(13, 'removeYear', 'checkbox', false, { advanced: true }), field(14, 'requiredFlags', 'select', [], { advanced: true })],
};

const IMPLEMENTATIONS = ['Newznab', 'Torznab'] as const;
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

type Resource = Record<string, unknown>;
type Rejected = { propertyName: string; errorMessage: string; severity: 'error' }[];
const invalid = (propertyName: string, errorMessage: string): { errors: Rejected } => ({ errors: [{ propertyName, errorMessage, severity: 'error' }] });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCategoryList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length <= 500 && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 999_999);
const isLanguageList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 20 && value.every((code) => typeof code === 'string' && /^[a-z]{2,3}$/.test(code));

// The values of the indexer for one app, in the shape of a Sonarr or Radarr indexer.
function resource(app: IndexerApp, indexer: Indexer): Resource {
  const push = indexer.push[app]!;
  const implementation = indexer.protocol === 'usenet' ? 'Newznab' : 'Torznab';
  const value = (name: string, fallback: unknown) => {
    if (name === 'baseUrl') return indexer.baseUrl;
    if (name === 'apiPath') return indexer.apiPath;
    if (name === 'apiKey') return MASK;
    if (name === 'categories') return push.categories;
    if (name === 'animeCategories') return push.animeCategories;
    if (name === 'minimumSeeders') return push.minimumSeeders;
    return name in push.fields ? push.fields[name] : fallback;
  };
  return {
    id: indexer.id,
    name: push.name,
    fields: SCHEMA_FIELDS[app].map(({ default: fallback, ...rest }) => ({ ...rest, value: value(rest.name, fallback) })),
    implementationName: implementation,
    implementation,
    configContract: `${implementation}Settings`,
    infoLink: '',
    tags: push.tags,
    enableRss: push.enableRss,
    enableAutomaticSearch: push.enableAutomaticSearch,
    enableInteractiveSearch: push.enableInteractiveSearch,
    supportsRss: true,
    supportsSearch: true,
    protocol: indexer.protocol ?? 'torrent',
    priority: push.priority,
    seasonSearchMaximumSingleEpisodeAge: 0,
    downloadClientId: push.downloadClientId ?? 0,
  };
}

const schemaResource = (app: IndexerApp, implementation: (typeof IMPLEMENTATIONS)[number]): Resource => ({
  id: 0,
  name: '',
  fields: SCHEMA_FIELDS[app].map(({ default: value, ...rest }) => ({ ...rest, value })),
  implementationName: implementation,
  implementation,
  configContract: `${implementation}Settings`,
  infoLink: '',
  tags: [],
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  supportsRss: true,
  supportsSearch: true,
  protocol: implementation === 'Torznab' ? 'torrent' : 'usenet',
  priority: 25,
  seasonSearchMaximumSingleEpisodeAge: 0,
  downloadClientId: 0,
});

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

const identity = (baseUrl: string, apiPath: string) => `${baseUrl.replace(/\/+$/, '')}${apiPath}`.toLowerCase();

const newHealth = (): IndexerHealth => ({ okAt: null, failedAt: null, failures: 0, retryAt: 0, error: null });

// One indexer record serves both apps. The indexer manager pushes the same indexer to Sonarr and to Radarr.
// A push of the same address changes the record. It never makes a second one.
export function savePush(db: Db, app: IndexerApp, parsed: Parsed, id?: number): Indexer | undefined {
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

export function removePush(db: Db, app: IndexerApp, id: number) {
  const indexer = db.data.indexers[id];
  if (!indexer?.push[app]) return false;
  delete indexer.push[app];
  if (!indexer.push.sonarr && !indexer.push.radarr) delete db.data.indexers[id];
  return true;
}

// The indexers that can serve a media type: the indexer manager pushed them to the matching app.
export function indexersFor(db: Db, mediaType: MediaType) {
  const app: IndexerApp = mediaType === 'movie' ? 'radarr' : 'sonarr';
  return Object.values(db.data.indexers).filter((indexer) => indexer.push[app]);
}

// The adapter that the indexer manager calls. It is thin: it only turns the Sonarr and Radarr shapes into the indexer records.
export function indexerManagerRouter(db: Db, app: IndexerApp, { onChange, urlBase = '' }: { onChange: () => void; urlBase?: string }) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set({ 'X-Application-Version': VERSION[app], 'Cache-Control': 'no-store' });
    next();
  });

  router.get('/system/status', (_req, res) => {
    res.json({ appName: app === 'sonarr' ? 'Sonarr' : 'Radarr', version: VERSION[app], urlBase: `${urlBase}/${app}` });
  });

  router.get('/indexer/schema', (_req, res) => {
    res.json(IMPLEMENTATIONS.map((implementation) => schemaResource(app, implementation)));
  });

  router.get('/indexer', (_req, res) => {
    res.json(Object.values(db.data.indexers).filter((indexer) => indexer.push[app]).map((indexer) => resource(app, indexer)));
  });

  router.get('/indexer/:id', (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer?.push[app]) return void res.status(404).json({ message: 'NotFound' });
    res.json(resource(app, indexer));
  });

  // The test only checks the body. The address is the address of the indexer manager, so ladarr does not call it here.
  router.post('/indexer/test', (req, res) => {
    const body = req.body as { implementation?: string };
    if (body?.implementation === 'Newznab') return void res.json({});
    const parsed = parsePush(app, body);
    if ('errors' in parsed) return void res.status(400).json(parsed.errors);
    res.json({});
  });

  const save: RequestHandler<{ id?: string }> = async (req, res) => {
    const parsed = parsePush(app, req.body);
    if ('errors' in parsed) return void res.status(400).json(parsed.errors);
    const id = req.params.id === undefined ? undefined : Number(req.params.id);
    const indexer = savePush(db, app, parsed, id);
    if (!indexer) {
      if (id !== undefined && !db.data.indexers[id]?.push[app]) return void res.status(404).json({ message: 'NotFound' });
      return void res.status(400).json(invalid('apiKey', 'The API key is missing.').errors);
    }
    await db.write();
    onChange();
    res.json(resource(app, indexer));
  };
  router.post('/indexer', save);
  router.put('/indexer/:id', save);

  router.delete('/indexer/:id', async (req, res) => {
    if (!removePush(db, app, Number(req.params.id))) return void res.status(404).json({ message: 'NotFound' });
    await db.write();
    onChange();
    res.json({});
  });

  return router;
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

// The form of Settings. An indexer that the user adds serves both apps, with the standard Torznab categories for series, anime, and movies.
const MANUAL_CATEGORIES: Record<IndexerApp, { categories: number[]; animeCategories: number[] }> = {
  sonarr: { categories: [5000], animeCategories: [5070] },
  radarr: { categories: [2000], animeCategories: [] },
};

// An indexer that exists keeps its key when the body leaves the key out, because the list does not hold the key.
function parseManual(body: unknown, existing?: Indexer): { parsed: Record<IndexerApp, Parsed>; delaySeconds: number; preferredLanguages: string[] } | { invalid: string } {
  if (!isObject(body)) return { invalid: 'body' };
  // Torznab is the only type for now. Newznab is Usenet, and ladarr does not use Usenet.
  if (body.type !== 'torznab') return { invalid: 'type' };
  const delaySeconds = body.delaySeconds ?? existing?.delaySeconds ?? DEFAULT_DELAY_SECONDS;
  if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS) return { invalid: 'delaySeconds' };
  const languages = body.preferredLanguages === undefined ? (existing?.preferredLanguages ?? []) : body.preferredLanguages;
  if (!isLanguageList(languages)) return { invalid: 'preferredLanguages' };
  for (const flag of ['enableRss', 'enableAutomaticSearch', 'enableInteractiveSearch']) if (body[flag] !== undefined && typeof body[flag] !== 'boolean') return { invalid: flag };
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey && !existing) return { invalid: 'apiKey' };
  const parsed = {} as Record<IndexerApp, Parsed>;
  for (const app of ['sonarr', 'radarr'] as const) {
    const result = parsePush(app, {
      implementation: 'Torznab',
      name: typeof body.name === 'string' ? body.name.trim() : body.name,
      enableRss: body.enableRss,
      enableAutomaticSearch: body.enableAutomaticSearch,
      enableInteractiveSearch: body.enableInteractiveSearch,
      fields: [
        { name: 'baseUrl', value: body.baseUrl },
        { name: 'apiKey', value: apiKey },
        { name: 'categories', value: MANUAL_CATEGORIES[app].categories },
        { name: 'animeCategories', value: MANUAL_CATEGORIES[app].animeCategories },
      ],
    });
    if ('errors' in result) return { invalid: result.errors[0]!.propertyName };
    parsed[app] = result;
  }
  return { parsed, delaySeconds, preferredLanguages: [...new Set(languages)] };
}

// A longer delay counts from the start of the last request, so the next request moves back.
function setDelay(indexer: Indexer, delaySeconds: number) {
  if (delaySeconds > indexer.delaySeconds && indexer.nextRequestAt > 0) indexer.nextRequestAt += (delaySeconds - indexer.delaySeconds) * 1000;
  indexer.delaySeconds = delaySeconds;
}

// The list for Settings. The indexer manager owns every value of the indexers that it pushed, except the delay and the preferred languages.
// The indexers that the user added can change, test, and go.
export function indexersRouter(db: Db, service?: IndexerService, { onChange = () => {} }: { onChange?: () => void } = {}) {
  const router = Router();
  const invalidSetting = (res: Response, field: string) => void res.status(400).json({ error: 'invalid_setting', field });
  const exists = (parsed: Parsed, id?: number) => Object.values(db.data.indexers).some((item) => item.id !== id && identity(item.baseUrl, item.apiPath) === identity(parsed.baseUrl, parsed.apiPath));

  router.get('/', (_req, res) => {
    res.json({ indexers: Object.values(db.data.indexers).map(summarize).sort((a, b) => a.name.localeCompare(b.name)) });
  });

  // The edit form shows the key of an indexer that the user added. The list and the answers to a change never hold it.
  router.get('/:id/key', (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer?.manual) return void res.status(404).json({ error: 'not_found' });
    res.json({ apiKey: indexer.apiKey });
  });

  router.post('/', async (req, res) => {
    const result = parseManual(req.body);
    if ('invalid' in result) return invalidSetting(res, result.invalid);
    if (exists(result.parsed.sonarr)) return void res.status(409).json({ error: 'exists' });
    const indexer = savePush(db, 'sonarr', result.parsed.sonarr)!;
    savePush(db, 'radarr', result.parsed.radarr);
    indexer.manual = true;
    indexer.preferredLanguages = result.preferredLanguages;
    setDelay(indexer, result.delaySeconds);
    await db.write();
    onChange();
    res.status(201).json({ indexer: summarize(indexer) });
  });

  if (service) {
    // Asks the indexer for its capabilities. It saves nothing.
    const probe = async (indexer: Indexer): Promise<IndexerTestResult> => {
      try {
        await service.test(indexer);
        return { ok: true as const };
      } catch (error) {
        if (!(error instanceof IndexerError)) throw error;
        return { ok: false as const, code: error.code };
      }
    };
    // A record that is not saved. Its ID is 0, so the limiter does not hold the request.
    const draft = (parsed: Parsed, apiKey: string): Indexer => ({ id: 0, baseUrl: parsed.baseUrl, apiPath: parsed.apiPath, apiKey, delaySeconds: 0, preferredLanguages: [], nextRequestAt: 0, push: {}, caps: null, capsAt: 0, health: newHealth() });

    // A check of the settings of the form, before the user saves them.
    router.post('/test', async (req, res) => {
      const result = parseManual(req.body);
      if ('invalid' in result) return invalidSetting(res, result.invalid);
      res.json(await probe(draft(result.parsed.sonarr, result.parsed.sonarr.apiKey!)));
    });

    // Tests the saved indexer, or the settings of the body when it has some, before the user saves them.
    router.post('/:id/test', async (req, res) => {
      const indexer = db.data.indexers[Number(req.params.id)];
      if (!indexer) return void res.status(404).json({ error: 'not_found' });
      if (!isObject(req.body) || !Object.keys(req.body).length) return void res.json(await probe(indexer));
      if (!indexer.manual) return void res.status(404).json({ error: 'not_found' });
      const result = parseManual(req.body, indexer);
      if ('invalid' in result) return invalidSetting(res, result.invalid);
      const probeDraft = draft(result.parsed.sonarr, result.parsed.sonarr.apiKey ?? indexer.apiKey);
      // The same address waits in the queue of the saved indexer, so the test respects its delay.
      if (identity(probeDraft.baseUrl, probeDraft.apiPath) === identity(indexer.baseUrl, indexer.apiPath)) probeDraft.id = indexer.id;
      res.json(await probe(probeDraft));
    });
  }

  router.put('/:id', async (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer?.manual) return void res.status(404).json({ error: 'not_found' });
    const result = parseManual(req.body, indexer);
    if ('invalid' in result) return invalidSetting(res, result.invalid);
    if (exists(result.parsed.sonarr, indexer.id)) return void res.status(409).json({ error: 'exists' });
    savePush(db, 'sonarr', result.parsed.sonarr, indexer.id);
    savePush(db, 'radarr', result.parsed.radarr, indexer.id);
    indexer.manual = true;
    indexer.preferredLanguages = result.preferredLanguages;
    setDelay(indexer, result.delaySeconds);
    await db.write();
    onChange();
    res.json({ indexer: summarize(indexer) });
  });

  router.patch('/:id', async (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer) return void res.status(404).json({ error: 'not_found' });
    const body = (req.body ?? {}) as { delaySeconds?: unknown; preferredLanguages?: unknown };
    if (typeof body.delaySeconds !== 'number' || !Number.isFinite(body.delaySeconds) || body.delaySeconds < 0 || body.delaySeconds > MAX_DELAY_SECONDS)
      return invalidSetting(res, 'delaySeconds');
    if (body.preferredLanguages !== undefined) {
      if (!isLanguageList(body.preferredLanguages)) return invalidSetting(res, 'preferredLanguages');
      indexer.preferredLanguages = [...new Set(body.preferredLanguages)];
    }
    setDelay(indexer, body.delaySeconds);
    await db.write();
    res.json({ indexer: summarize(indexer) });
  });

  // The queue entries of a removed indexer keep their release. The decision step reports `indexer_removed` for them.
  router.delete('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!db.data.indexers[id]?.manual) return void res.status(404).json({ error: 'not_found' });
    delete db.data.indexers[id];
    await db.write();
    onChange();
    res.status(204).end();
  });
  return router;
}
