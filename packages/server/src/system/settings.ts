import type { SettingsResponse, SettingsSaved } from '@ladarr/shared/types';
import { Router } from 'express';
import { profilesInOrder, type Db, type Settings } from '../core/db.ts';
import { languageOfRegion } from '../core/languages.ts';
import { configureItemLogs } from '../core/log.ts';
import { templateProblem } from '../library/naming.ts';
import { QUALITY_TABLE_VERSION } from '../acquisition/quality.ts';

const isTimeZone = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Returns the changes to apply, or the name of the first field that is not valid.
function parseChanges(db: Db, body: unknown): Partial<Settings> | { invalid: string } {
  if (!isObject(body)) return { invalid: 'body' };
  const changes: Partial<Settings> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'region' && typeof value === 'string' && /^[A-Z]{2}$/.test(value)) changes.region = value;
    else if (key === 'timeZone' && isTimeZone(value)) changes.timeZone = value;
    else if (key === 'language' && (value === 'en' || value === 'es')) changes.language = value;
    else if (key === 'theme' && (value === 'dark' || value === 'light')) changes.theme = value;
    else if (key === 'keepQueueLogs' && typeof value === 'boolean') changes.keepQueueLogs = value;
    else if (key === 'naming' && isObject(value) && !templateProblem('movie', value.movie) && !templateProblem('episode', value.episode)) {
      changes.naming = { movie: (value.movie as string).trim(), episode: (value.episode as string).trim() };
    } else if (key === 'audio' && value === null) changes.audio = null;
    else if (
      key === 'audio' &&
      isObject(value) &&
      typeof value.language === 'string' &&
      /^[a-z]{2,3}$/.test(value.language) &&
      typeof value.strict === 'boolean'
    ) {
      changes.audio = { language: value.language, strict: value.strict };
    } else if (key === 'defaultRoots' && isObject(value)) {
      const roots = { ...db.data.settings.defaultRoots };
      for (const type of ['movie', 'tv'] as const) {
        if (!(type in value)) continue;
        const id = value[type];
        // A default must be a saved folder for the same media type.
        if (id !== null && (typeof id !== 'string' || db.data.roots[id]?.mediaType !== type)) return { invalid: `defaultRoots.${type}` };
        roots[type] = id;
      }
      changes.defaultRoots = roots;
    } else return { invalid: key };
  }
  return changes;
}

// The languages that the aliases of the library use. The tag input of the indexer settings offers this list.
function aliasLanguageOptions(db: Db): string[] {
  const codes = new Set<string>();
  for (const title of Object.values(db.data.titles)) {
    for (const regions of Object.values(title.meta.aliasRegions ?? {})) {
      for (const region of regions) codes.add(languageOfRegion(region));
    }
  }
  return [...codes].sort();
}

export function settingsRouter(db: Db) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({
      settings: db.data.settings,
      presets: profilesInOrder(db.data).map(({ id, name }) => ({ id, label: name })),
      qualityTableVersion: QUALITY_TABLE_VERSION,
      aliasLanguageOptions: aliasLanguageOptions(db),
    } satisfies SettingsResponse);
  });

  router.patch('/', async (req, res) => {
    const changes = parseChanges(db, req.body);
    if ('invalid' in changes) return void res.status(400).json({ error: 'invalid_setting', field: changes.invalid });
    Object.assign(db.data.settings, changes);
    if ('keepQueueLogs' in changes) configureItemLogs(db);
    await db.write();
    res.json({ settings: db.data.settings } satisfies SettingsSaved);
  });

  // The setup ends when both default folders exist. No download can start before that.
  router.post('/complete-setup', async (_req, res) => {
    const { defaultRoots } = db.data.settings;
    if (!defaultRoots.movie || !defaultRoots.tv) return void res.status(400).json({ error: 'roots_required' });
    db.data.settings.setupCompleted = true;
    await db.write();
    res.json({ settings: db.data.settings });
  });

  return router;
}
