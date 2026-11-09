import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/core/db.ts';
import { setupChecks } from '../../src/system/setup-checks.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { indexer } from '../helpers/test-fixtures.ts';

let db: Db;

beforeAll(async () => {
  db = await openDb('unused.json');
});

describe('setup checks', () => {
  it('reports no client and no indexer on a new install', async () => {
    expect(await setupChecks(db)).toEqual({ client: { state: 'unconfigured' }, indexers: { series: 0, movies: 0 } });
  });

  it.each(['ok', 'rejected', 'unreachable'] as const)('reports the answer of the client check: %s', async (state) => {
    expect(await setupChecks(db, async () => state)).toMatchObject({ client: { state } });
  });

  it('counts the indexers that the indexer manager pushed for each app', async () => {
    const both = indexer({ id: 1 });
    const seriesOnly = indexer({ id: 2, push: { sonarr: both.push.sonarr } });
    const moviesOnly = indexer({ id: 3, push: { radarr: both.push.radarr } });
    db.data.indexers = { 1: both, 2: seriesOnly, 3: moviesOnly };
    expect((await setupChecks(db)).indexers).toEqual({ series: 2, movies: 2 });
    db.data.indexers = { 2: seriesOnly };
    expect((await setupChecks(db)).indexers).toEqual({ series: 1, movies: 0 });
  });

  it('answers on the route after the sign-in, and without a client when the services are not there', async () => {
    const app = await startTestApp();
    try {
      app.db.data.indexers = { 1: indexer() };
      expect((await app.get('/system/setup-checks')).body).toEqual({ client: { state: 'unconfigured' }, indexers: { series: 1, movies: 1 } });
      const anonymous = await fetch(`${app.base}/system/setup-checks`);
      expect(anonymous.status).toBe(401);
    } finally {
      app.close();
    }
  });
});
