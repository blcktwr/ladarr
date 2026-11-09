import type { IndexerTestResult } from '@ladarr/shared/types';
import type { Response } from 'express';
import {
  DEFAULT_DELAY_SECONDS,
  MAX_DELAY_SECONDS,
  identity,
  isLanguageList,
  isObject,
  newHealth,
  parsePush,
  type Indexer,
  type IndexerApp,
  type Parsed,
} from '../library/grab/indexers.ts';
import { IndexerError, type IndexerService } from '../library/grab/torznab.ts';
import type { Db } from '../core/db.ts';

export const invalidSetting = (res: Response, field: string) => void res.status(400).json({ error: 'invalid_setting', field });
export const exists = (db: Db, parsed: Parsed, id?: number) =>
  Object.values(db.data.indexers).some((item) => item.id !== id && identity(item.baseUrl, item.apiPath) === identity(parsed.baseUrl, parsed.apiPath));

// The form of Settings. An indexer that the user adds serves both apps, with the standard Torznab categories for series, anime, and movies.
const MANUAL_CATEGORIES: Record<IndexerApp, { categories: number[]; animeCategories: number[] }> = {
  sonarr: { categories: [5000], animeCategories: [5070] },
  radarr: { categories: [2000], animeCategories: [] },
};

// An indexer that exists keeps its key when the body leaves the key out, because the list does not hold the key.
export function parseManual(body: unknown, existing?: Indexer): { parsed: Record<IndexerApp, Parsed>; delaySeconds: number; preferredLanguages: string[] } | { invalid: string } {
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
export function setDelay(indexer: Indexer, delaySeconds: number) {
  if (delaySeconds > indexer.delaySeconds && indexer.nextRequestAt > 0) indexer.nextRequestAt += (delaySeconds - indexer.delaySeconds) * 1000;
  indexer.delaySeconds = delaySeconds;
}

// Asks the indexer for its capabilities. It saves nothing.
export async function probe(service: IndexerService, indexer: Indexer): Promise<IndexerTestResult> {
  try {
    await service.test(indexer);
    return { ok: true as const };
  } catch (error) {
    if (!(error instanceof IndexerError)) throw error;
    return { ok: false as const, code: error.code };
  }
}

// A record that is not saved. Its ID is 0, so the limiter does not hold the request.
export const draft = (parsed: Parsed, apiKey: string): Indexer => ({ id: 0, baseUrl: parsed.baseUrl, apiPath: parsed.apiPath, apiKey, delaySeconds: 0, preferredLanguages: [], nextRequestAt: 0, push: {}, caps: null, capsAt: 0, health: newHealth() });
