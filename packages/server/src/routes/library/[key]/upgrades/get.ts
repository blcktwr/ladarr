import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { upgradeQualities } from '../../../../library/grab/upgrades.ts';

// The qualities that the Upgrade button of the page offers: the ones that the profile chain defines above a file.
export function libraryUpgrades(): RequestHandler<{ key: string }> {
  return (_req, res) => {
    res.json({ qualities: upgradeQualities(res.locals.title) });
  };
}
