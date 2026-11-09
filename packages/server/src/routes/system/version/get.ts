import type { VersionInfo } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { APP_VERSION } from '../../../system/version.ts';

export function systemVersion(): RequestHandler {
  return (_req, res) => {
    res.json({ version: APP_VERSION } satisfies VersionInfo);
  };
}
