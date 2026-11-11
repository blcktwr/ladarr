import type { SetupChecks } from '@ladarr/shared/types';
import type { ClientCheck } from '../library/downloads/client-api.ts';
import { type Db, db } from '../core/db.ts';

// What the setup shows about the two connections that a download needs.
// The client check keeps its answer for a minute, so a page that checks again does not sign in each time.
export async function setupChecks(clientCheck?: () => Promise<ClientCheck>): Promise<SetupChecks> {
  const indexers = Object.values(db.data.indexers);
  return {
    client: { state: clientCheck ? await clientCheck() : 'unconfigured' },
    indexers: { series: indexers.filter((indexer) => indexer.push.sonarr).length, movies: indexers.filter((indexer) => indexer.push.radarr).length },
  };
}
