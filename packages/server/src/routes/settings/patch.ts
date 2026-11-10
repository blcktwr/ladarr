import { type Db, type Settings, db } from '../../core/db.ts';
import type { SettingsSaved } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { configureItemLogs } from '../../core/log.ts';
import { templateProblem } from '../../library/naming.ts';

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
function parseChanges(body: unknown): Partial<Settings> | { invalid: string } {
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

export function settingsPatch(): RequestHandler {
  return async (req, res) => {
    const changes = parseChanges(req.body);
    if ('invalid' in changes) return void res.status(400).json({ error: 'invalid_setting', field: changes.invalid });
    Object.assign(db.data.settings, changes);
    if ('keepQueueLogs' in changes) configureItemLogs();
    await db.write();
    res.json({ settings: db.data.settings } satisfies SettingsSaved);
  };
}
