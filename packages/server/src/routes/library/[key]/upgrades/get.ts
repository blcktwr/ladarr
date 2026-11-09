import type { RequestHandler } from 'express';
import { upgradeResolutions } from '../../../../library/grab/upgrades.ts';
import type { Db } from '../../../../core/db.ts';

// The resolutions that the Upgrade button of the page offers: the ones that the profile chain defines above a file.
export function libraryUpgrades(db: Db): RequestHandler<{ key: string }> {
  return (_req, res) => {
    res.json({ resolutions: upgradeResolutions(db, res.locals.title) });
  };
}
