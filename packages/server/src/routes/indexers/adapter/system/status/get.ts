import type { RequestHandler } from 'express';
import { VERSION } from '../../../../../helpers/indexers-adapter.ts';
import type { IndexerApp } from '@ladarr/shared/enums';

export function indexerSystemStatus(app: IndexerApp, { urlBase = '' }: { urlBase?: string } = {}): RequestHandler {
  return (_req, res) => {
    res.json({ appName: app === 'sonarr' ? 'Sonarr' : 'Radarr', version: VERSION[app], urlBase });
  };
}
