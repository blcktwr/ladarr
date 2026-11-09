import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../../src/core/db.ts';
import { createLimiter } from '../../src/core/limiter.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { createIndexerService } from '../../src/acquisition/torznab.ts';

const CAPS = '<caps><searching><search available="yes" supportedParams="q"/></searching><categories><category id="5000" name="TV"/></categories></caps>';

let app: Awaited<ReturnType<typeof startTestApp>>;
const requests: URL[] = [];
let offline = false;

// The fake indexer: it knows one key. A request with another key is rejected.
const fake = (async (input: URL | string) => {
  const url = new URL(String(input));
  requests.push(url);
  if (offline) throw new Error('offline');
  if (url.pathname === '/9/not-torznab/api') return new Response('<html></html>');
  return url.searchParams.get('apikey') === 'good' ? new Response(CAPS) : new Response('no', { status: 401 });
}) as typeof fetch;

const body = (overrides: Record<string, unknown> = {}) => ({ name: 'Tracker', type: 'torznab', baseUrl: 'http://127.0.0.1:9/1/', apiKey: 'good', ...overrides });

beforeAll(async () => {
  const db = await openDb('unused.json');
  app = await startTestApp({ indexers: createIndexerService(db, createLimiter(db), { fetch: fake }) }, db);
});
afterAll(() => app.close());

describe('indexers that the user adds', () => {
  it('adds an indexer for both apps and never sends the key back', async () => {
    const res = await app.post('/indexers', body({ delaySeconds: 3, preferredLanguages: ['es', 'ja'] }));
    expect(res.status).toBe(201);
    expect(res.body.indexer).toMatchObject({ name: 'Tracker', manual: true, apps: ['radarr', 'sonarr'], baseUrl: 'http://127.0.0.1:9/1/', delaySeconds: 3, preferredLanguages: ['es', 'ja'], enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true });
    expect(JSON.stringify(res.body)).not.toContain('good');
    expect((await app.get(`/indexers/${res.body.indexer.id}/key`)).body).toEqual({ apiKey: 'good' });
    expect((await app.get('/indexers')).body.indexers.some((item: object) => 'apiKey' in item)).toBe(false);
    expect((await app.get('/indexers')).body.indexers[0].preferredLanguages).toEqual(['es', 'ja']);
    const saved = app.db.data.indexers[res.body.indexer.id]!;
    expect(saved).toMatchObject({ apiKey: 'good', manual: true, preferredLanguages: ['es', 'ja'], push: { sonarr: { categories: [5000], animeCategories: [5070] }, radarr: { categories: [2000] } } });
  });

  it('rejects an indexer that is not valid, or that is in the list', async () => {
    const field = async (overrides: Record<string, unknown>) => (await app.post('/indexers', body(overrides))).body.field;
    expect(await field({ name: ' ' })).toBe('name');
    expect(await field({ type: 'newznab' })).toBe('type');
    expect(await field({ baseUrl: 'http://user:pass@127.0.0.1:9/2/' })).toBe('baseUrl');
    expect(await field({ baseUrl: 'nothing' })).toBe('baseUrl');
    expect(await field({ apiKey: '' })).toBe('apiKey');
    expect(await field({ delaySeconds: -1 })).toBe('delaySeconds');
    expect(await field({ enableRss: 'yes' })).toBe('enableRss');
    expect(await field({ preferredLanguages: 'es' })).toBe('preferredLanguages');
    expect(await field({ preferredLanguages: ['ES'] })).toBe('preferredLanguages');
    expect(await field({ preferredLanguages: ['toolong'] })).toBe('preferredLanguages');
    expect(await field({ preferredLanguages: [1] })).toBe('preferredLanguages');
    const same = await app.post('/indexers', body({ name: 'Copy' }));
    expect(same.status).toBe(409);
    expect(Object.keys(app.db.data.indexers)).toHaveLength(1);
  });

  it('changes an indexer and keeps its key when the body has none', async () => {
    const id = Object.values(app.db.data.indexers)[0]!.id;
    const res = await app.fetchJson('PUT', `/indexers/${id}`, { name: 'Renamed', type: 'torznab', baseUrl: 'http://127.0.0.1:9/1/', apiKey: '', delaySeconds: 8, enableRss: false, enableAutomaticSearch: true, enableInteractiveSearch: false });
    expect(res.status).toBe(200);
    expect(res.body.indexer).toMatchObject({ name: 'Renamed', delaySeconds: 8, preferredLanguages: ['es', 'ja'], enableRss: false, enableAutomaticSearch: true, enableInteractiveSearch: false });
    expect(app.db.data.indexers[id]).toMatchObject({ apiKey: 'good', manual: true });
    expect((await app.fetchJson('PUT', `/indexers/${id}`, { name: 'Renamed', type: 'torznab', baseUrl: 'ftp://nothing', apiKey: '' })).body.field).toBe('baseUrl');
    expect((await app.fetchJson('PUT', '/indexers/99', body())).status).toBe(404);
  });

  it('changes the languages that the indexer prefers', async () => {
    const id = Object.values(app.db.data.indexers)[0]!.id;
    const updated = await app.fetchJson('PUT', `/indexers/${id}`, { name: 'Renamed', type: 'torznab', baseUrl: 'http://127.0.0.1:9/1/', apiKey: '', delaySeconds: 8, preferredLanguages: ['de'] });
    expect(updated.status).toBe(200);
    expect(updated.body.indexer.preferredLanguages).toEqual(['de']);

    const changed = await app.patch(`/indexers/${id}`, { delaySeconds: 8, preferredLanguages: ['fr', 'it'] });
    expect(changed.status).toBe(200);
    expect(changed.body.indexer.preferredLanguages).toEqual(['fr', 'it']);
    expect(app.db.data.indexers[id]!.preferredLanguages).toEqual(['fr', 'it']);

    const refused = await app.patch(`/indexers/${id}`, { delaySeconds: 8, preferredLanguages: ['ES'] });
    expect(refused.body).toEqual({ error: 'invalid_setting', field: 'preferredLanguages' });
    expect(app.db.data.indexers[id]!.preferredLanguages).toEqual(['fr', 'it']);
  });

  it('moves the next request back when the delay grows', async () => {
    const id = Object.values(app.db.data.indexers)[0]!.id;
    const indexer = app.db.data.indexers[id]!;

    const lastStart = Date.now() - 1_000;
    try {
      indexer.delaySeconds = 10;
      indexer.nextRequestAt = lastStart + 10_000;

      const res = await app.patch(`/indexers/${id}`, { delaySeconds: 30 });
      expect(res.status).toBe(200);
      expect(indexer.delaySeconds).toBe(30);
      expect(indexer.nextRequestAt).toBeGreaterThanOrEqual(lastStart + 30_000);
      expect(indexer.nextRequestAt).toBeLessThanOrEqual(lastStart + 30_000 + 200);

      indexer.delaySeconds = 30;
      indexer.nextRequestAt = lastStart + 30_000;

      const second = await app.patch(`/indexers/${id}`, { delaySeconds: 60 });
      expect(second.status).toBe(200);
      expect(indexer.nextRequestAt).toBeGreaterThanOrEqual(lastStart + 60_000);
    } finally {
      // Leave the indexer usable for the later tests.
      indexer.delaySeconds = 8;
      indexer.nextRequestAt = 0;
    }
  });

  it('tests the settings of the form without saving them', async () => {
    const before = JSON.stringify(app.db.data.indexers);
    expect((await app.post('/indexers/test', body())).body).toEqual({ ok: true });
    expect((await app.post('/indexers/test', body({ apiKey: 'bad' }))).body).toEqual({ ok: false, code: 'rejected' });
    expect((await app.post('/indexers/test', body({ baseUrl: 'http://127.0.0.1:9/9/not-torznab/' }))).body).toEqual({ ok: false, code: 'invalid_response' });
    offline = true;
    expect((await app.post('/indexers/test', body())).body).toEqual({ ok: false, code: 'unavailable' });
    offline = false;
    expect((await app.post('/indexers/test', body({ baseUrl: 'nothing' }))).body.field).toBe('baseUrl');
    expect(JSON.stringify(app.db.data.indexers)).toBe(before);
  });

  it('tests the saved indexer with the saved key', async () => {
    const id = Object.values(app.db.data.indexers)[0]!.id;
    requests.length = 0;
    expect((await app.post(`/indexers/${id}/test`)).body).toEqual({ ok: true });
    // The second call must not wait for the delay of the first one.
    app.db.data.indexers[id]!.nextRequestAt = 0;
    expect((await app.post(`/indexers/${id}/test`, body({ name: 'Renamed', apiKey: '' }))).body).toEqual({ ok: true });
    expect(requests.map((url) => url.searchParams.get('apikey'))).toEqual(['good', 'good']);
    expect(app.db.data.indexers[id]!.health.okAt).not.toBeNull();
    expect((await app.post('/indexers/99/test')).status).toBe(404);
  });

  it('makes a test of the saved form settings wait for the delay of the indexer', async () => {
    const id = Object.values(app.db.data.indexers)[0]!.id;
    const indexer = app.db.data.indexers[id]!;
    indexer.delaySeconds = 0.2;
    indexer.nextRequestAt = Date.now() + 200;

    requests.length = 0;
    const began = Date.now();
    expect((await app.post(`/indexers/${id}/test`, body({ name: 'Renamed', apiKey: '' }))).body).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(Date.now() - began).toBeGreaterThanOrEqual(190);
    expect(indexer.nextRequestAt).toBeGreaterThanOrEqual(began + 190);
  });

  it('lets a push from the indexer manager take the indexer over', async () => {
    const id = Object.values(app.db.data.indexers)[0]!.id;
    const key = app.db.data.apiKey!;
    const root = app.base.replace(/\/api$/, '');
    const push = await fetch(`${root}/sonarr/api/v3/indexer`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pushed', implementation: 'Torznab', fields: [{ name: 'baseUrl', value: 'http://127.0.0.1:9/1/' }, { name: 'apiKey', value: 'other' }, { name: 'categories', value: [5030] }] }),
    });
    expect(push.status).toBe(200);
    expect(app.db.data.indexers[id]!.manual).toBeUndefined();
    expect((await app.fetchJson('PUT', `/indexers/${id}`, body())).status).toBe(404);
    expect((await app.get(`/indexers/${id}/key`)).status).toBe(404);
    expect((await app.del(`/indexers/${id}`)).status).toBe(404);
    expect((await app.patch(`/indexers/${id}`, { delaySeconds: 2 })).body.indexer.delaySeconds).toBe(2);
  });

  it('removes an indexer that the user added', async () => {
    const added = await app.post('/indexers', body({ baseUrl: 'http://127.0.0.1:9/2/' }));
    const id = added.body.indexer.id;
    expect((await app.del(`/indexers/${id}`)).status).toBe(204);
    expect(app.db.data.indexers[id]).toBeUndefined();
    expect((await app.del(`/indexers/${id}`)).status).toBe(404);
  });
});
