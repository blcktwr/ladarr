import type { RequestHandler } from 'express';
import type { IndexerApp } from '../../../../../library/grab/indexers.ts';
import { VERSION } from '../../../../../helpers/indexers-adapter.ts';

export function indexerSystemStatus(app: IndexerApp, { urlBase = '' }: { urlBase?: string } = {}): RequestHandler {
  return (_req, res) => {
    res.json({ appName: app === 'sonarr' ? 'Sonarr' : 'Radarr', version: VERSION[app], urlBase });
  };
}
