import type { SettingsResponse } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { QUALITY_TABLE_VERSION } from '../../library/grab/quality.ts';
import { profilesInOrder, type Db } from '../../core/db.ts';
import { languageOfRegion } from '../../core/languages.ts';

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

export function settingsGet(db: Db): RequestHandler {
  return (_req, res) => {
    res.json({
      settings: db.data.settings,
      presets: profilesInOrder(db.data).map(({ id, name }) => ({ id, label: name })),
      qualityTableVersion: QUALITY_TABLE_VERSION,
      aliasLanguageOptions: aliasLanguageOptions(db),
    } satisfies SettingsResponse);
  };
}
