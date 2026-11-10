import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { upgradeResolutions } from '../../../../library/grab/upgrades.ts';

// The resolutions that the Upgrade button of the page offers: the ones that the profile chain defines above a file.
export function libraryUpgrades(): RequestHandler<{ key: string }> {
  return (_req, res) => {
    res.json({ resolutions: upgradeResolutions(res.locals.title) });
  };
}
