import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/test-app.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
let key = '';
let sonarr = '';
let radarr = '';

beforeAll(async () => {
  app = await startTestApp();
  key = app.db.data.apiKey!;
  const root = app.base.replace(/\/api$/, '');
  sonarr = `${root}/sonarr/api/v3`;
  radarr = `${root}/radarr/api/v3`;
});
afterAll(() => app.close());

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-api-key': key }) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, version: res.headers.get('x-application-version'), body: await res.json().catch(() => undefined) };
}

// The body that the indexer manager builds from the schema.
const pushed = (categories: number[], overrides: Record<string, unknown> = {}) => ({
  id: 0,
  name: 'Tracker',
  implementation: 'Torznab',
  configContract: 'TorznabSettings',
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  priority: 25,
  tags: [],
  fields: [
    { name: 'baseUrl', value: 'http://indexer:9696/3/' },
    { name: 'apiPath', value: '/api' },
    { name: 'apiKey', value: 'indexer-secret' },
    { name: 'categories', value: categories },
    { name: 'animeCategories', value: [5070] },
    { name: 'minimumSeeders', value: 3 },
    { name: 'seedCriteria.seedRatio', value: 1.5 },
  ],
  ...overrides,
});

describe('indexer manager adapter', () => {
  it('rejects a request without the API key', async () => {
    expect((await call(sonarr, 'GET', '/indexer', undefined, {})).status).toBe(401);
    expect((await call(sonarr, 'GET', '/indexer', undefined, { 'x-api-key': 'wrong' })).status).toBe(401);
  });

  it('reports a version that the indexer manager accepts', async () => {
    const res = await call(sonarr, 'POST', '/indexer/test', pushed([5030]));
    expect(res.status).toBe(200);
    const [major, minor, patch] = res.version!.split('.').map(Number);
    expect([major!, minor!, patch!] > [3, 0, 5]).toBe(true);
    expect((await call(radarr, 'GET', '/system/status')).body).toMatchObject({ appName: 'Radarr' });
  });

  it('lists the schemas that the indexer manager looks up by name', async () => {
    const { body } = await call(sonarr, 'GET', '/indexer/schema');
    expect(body.map((item: { implementation: string }) => item.implementation).sort()).toEqual(['Newznab', 'Torznab']);
    const torznab = body.find((item: { implementation: string }) => item.implementation === 'Torznab');
    const names = torznab.fields.map((item: { name: string }) => item.name);
    for (const name of ['baseUrl', 'apiPath', 'apiKey', 'categories', 'animeCategories', 'minimumSeeders', 'seedCriteria.seedRatio', 'seedCriteria.seedTime', 'seedCriteria.seasonPackSeedTime', 'rejectBlocklistedTorrentHashesWhileGrabbing', 'additionalParameters']) {
      expect(names).toContain(name);
    }
    const radarrNames = (await call(radarr, 'GET', '/indexer/schema')).body[1].fields.map((item: { name: string }) => item.name);
    expect(radarrNames).toContain('requiredFlags');
    expect(radarrNames).not.toContain('animeCategories');
  });

  it('keeps one record for repeated pushes and for both apps', async () => {
    const first = await call(sonarr, 'POST', '/indexer', pushed([5030, 5040]));
    expect(first.status).toBe(200);
    const again = await call(sonarr, 'POST', '/indexer', pushed([5030, 5040]));
    expect(again.body.id).toBe(first.body.id);
    const movie = await call(radarr, 'POST', '/indexer', pushed([2040, 2045]));
    expect(movie.body.id).toBe(first.body.id);
    expect(Object.keys(app.db.data.indexers)).toHaveLength(1);

    // Each app sees its own categories on the shared record.
    expect((await call(sonarr, 'GET', `/indexer/${first.body.id}`)).body.fields.find((item: { name: string }) => item.name === 'categories').value).toEqual([5030, 5040]);
    expect((await call(radarr, 'GET', `/indexer/${first.body.id}`)).body.fields.find((item: { name: string }) => item.name === 'categories').value).toEqual([2040, 2045]);
  });

  it('sends back what the indexer manager pushed, with the key masked', async () => {
    const [listed] = (await call(sonarr, 'GET', '/indexer')).body;
    const value = (name: string) => listed.fields.find((item: { name: string }) => item.name === name).value;
    expect(value('baseUrl')).toBe('http://indexer:9696/3/');
    expect(value('apiPath')).toBe('/api');
    expect(value('apiKey')).toBe('********');
    expect(value('animeCategories')).toEqual([5070]);
    expect(value('minimumSeeders')).toBe(3);
    expect(value('seedCriteria.seedRatio')).toBe(1.5);
    expect(JSON.stringify(listed)).not.toContain('indexer-secret');
    expect(listed).toMatchObject({ protocol: 'torrent', implementation: 'Torznab', priority: 25, enableRss: true });
  });

  it('keeps the stored key when the indexer manager sends the mask', async () => {
    const { body } = await call(sonarr, 'GET', '/indexer');
    const masked = pushed([5030, 5040], { id: body[0].id, name: 'Renamed', priority: 10 });
    masked.fields[2] = { name: 'apiKey', value: '********' };
    const res = await call(sonarr, 'PUT', `/indexer/${body[0].id}?forceSave=true`, masked);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', priority: 10 });
    expect(app.db.data.indexers[body[0].id].apiKey).toBe('indexer-secret');
  });

  it('keeps the delay that the user set when the indexer manager pushes again', async () => {
    const id = Object.values(app.db.data.indexers)[0]!.id;
    expect((await app.patch(`/indexers/${id}`, { delaySeconds: 9 })).body.indexer.delaySeconds).toBe(9);
    await call(sonarr, 'POST', '/indexer', pushed([5030, 5040]));
    expect(app.db.data.indexers[id]!.delaySeconds).toBe(9);
  });

  it('keeps the preferred languages that the user set when the indexer manager pushes again', async () => {
    const id = Object.values(app.db.data.indexers)[0]!.id;
    expect((await app.patch(`/indexers/${id}`, { delaySeconds: 9, preferredLanguages: ['ja'] })).body.indexer.preferredLanguages).toEqual(['ja']);
    await call(sonarr, 'POST', '/indexer', pushed([5030, 5040]));
    expect(app.db.data.indexers[id]!.preferredLanguages).toEqual(['ja']);
  });

  it('rejects a push that is not valid', async () => {
    const bad = (fields: unknown[], extra: Record<string, unknown> = {}) => call(sonarr, 'POST', '/indexer', { ...pushed([5030]), fields, ...extra });
    expect((await call(sonarr, 'POST', '/indexer', pushed([5030], { implementation: 'Other' }))).status).toBe(400);
    expect((await bad([{ name: 'baseUrl', value: 'http://user:pass@host/1/' }, { name: 'apiKey', value: 'k' }])).status).toBe(400);
    expect((await bad([{ name: 'baseUrl', value: 'ftp://host/1/' }, { name: 'apiKey', value: 'k' }])).status).toBe(400);
    expect((await bad([{ name: 'baseUrl', value: 'http://other:9696/9/' }])).status).toBe(400);
    expect((await bad([{ name: 'baseUrl', value: 'http://other:9696/9/' }, { name: 'apiKey', value: 'k' }, { name: 'categories', value: ['x'] }])).status).toBe(400);
    expect((await bad([{ name: 'baseUrl', value: 'http://other:9696/9/' }, { name: 'apiKey', value: 'k' }, { name: 'apiPath', value: '/api?x=1' }])).status).toBe(400);
    expect(Object.keys(app.db.data.indexers)).toHaveLength(1);
  });

  it('answers 404 for an unknown indexer, so the indexer manager pushes it again', async () => {
    expect((await call(sonarr, 'GET', '/indexer/99')).status).toBe(404);
    expect((await call(sonarr, 'PUT', '/indexer/99', pushed([5030]))).status).toBe(404);
    expect((await call(sonarr, 'DELETE', '/indexer/99')).status).toBe(404);
  });

  it('removes an app from the record, and the record when no app is left', async () => {
    const id = Object.values(app.db.data.indexers)[0]!.id;
    expect((await call(sonarr, 'DELETE', `/indexer/${id}`)).status).toBe(200);
    expect((await call(sonarr, 'GET', `/indexer/${id}`)).status).toBe(404);
    expect((await call(radarr, 'GET', `/indexer/${id}`)).status).toBe(200);
    expect((await call(radarr, 'DELETE', `/indexer/${id}`)).status).toBe(200);
    expect(app.db.data.indexers).toEqual({});
  });

  it('shows the indexers in a read-only list', async () => {
    await call(sonarr, 'POST', '/indexer', pushed([5030]));
    const { body } = await app.get('/indexers');
    expect(body.indexers).toHaveLength(1);
    expect(body.indexers[0]).toMatchObject({ name: 'Tracker', apps: ['sonarr'], delaySeconds: 6, preferredLanguages: [] });
    expect(JSON.stringify(body)).not.toContain('indexer-secret');
    expect((await app.patch(`/indexers/${body.indexers[0].id}`, { delaySeconds: -1 })).status).toBe(400);
    expect((await app.patch(`/indexers/${body.indexers[0].id}`, { name: 'x' })).status).toBe(400);
  });
});
