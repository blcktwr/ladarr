import { db, profilesInOrder } from '../../core/db.ts';
import type { SettingsResponse } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { QUALITY_TABLE_VERSION } from '../../library/grab/quality.ts';

export function settingsGet(): RequestHandler {
  return (_req, res) => {
    res.json({
      settings: db.data.settings,
      presets: profilesInOrder(db.data).map(({ id, name }) => ({ id, label: name })),
      qualityTableVersion: QUALITY_TABLE_VERSION,
    } satisfies SettingsResponse);
  };
}
