import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notUsedReason, seedLimits } from '../../src/acquisition/indexers.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { indexer } from '../helpers/test-fixtures.ts';

describe('what the indexer manager pushes with an indexer', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let sonarr = '';
  beforeAll(async () => {
    app = await startTestApp();
    sonarr = `${app.base.replace(/\/api$/, '')}/sonarr/api/v3`;
  });
  afterAll(() => app.close());

  const push = async (path: string, overrides: Record<string, unknown> = {}) => {
    const res = await fetch(`${sonarr}/indexer`, {
      method: 'POST',
      headers: { 'x-api-key': app.db.data.apiKey!, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 0,
        name: `Tracker ${path}`,
        implementation: 'Torznab',
        enableRss: true,
        enableAutomaticSearch: true,
        enableInteractiveSearch: true,
        priority: 25,
        tags: [],
        fields: [
          { name: 'baseUrl', value: `http://indexer:9696/${path}/` },
          { name: 'apiKey', value: 'k' },
          { name: 'categories', value: [5030] },
        ],
        ...overrides,
      }),
    });
    return { status: res.status, body: await res.json() };
  };
  const listed = async (id: number) => (await app.get('/indexers')).body.indexers.find((item: { id: number }) => item.id === id);

  it('keeps a Usenet indexer and says in the list that ladarr does not use it', async () => {
    const res = await push('usenet', { implementation: 'Newznab' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ implementation: 'Newznab', protocol: 'usenet' });
    expect((await listed(res.body.id)).notUsed).toEqual([{ app: 'sonarr', reason: 'usenet' }]);
  });

  it('stores the tags and the download client, and sends them back', async () => {
    const res = await push('tagged', { tags: [4], downloadClientId: 7 });
    expect(res.body).toMatchObject({ tags: [4], downloadClientId: 7 });
    expect((await listed(res.body.id)).notUsed).toEqual([{ app: 'sonarr', reason: 'tags' }]);
    const other = await push('client', { downloadClientId: 7 });
    expect((await listed(other.body.id)).notUsed).toEqual([{ app: 'sonarr', reason: 'download_client' }]);
    expect((await push('bad-client', { downloadClientId: -1 })).status).toBe(400);
  });

  it('uses an indexer with no tag and the default download client', async () => {
    const res = await push('plain', { tags: [], downloadClientId: null });
    expect(res.status).toBe(200);
    expect((await listed(res.body.id)).notUsed).toEqual([]);
  });

  it('decides per app, because the indexer manager pushes the tags to each app', () => {
    const item = indexer({ push: { sonarr: { ...indexer().push.sonarr!, tags: [1] }, radarr: indexer().push.radarr } });
    expect(notUsedReason(item, 'sonarr')).toBe('tags');
    expect(notUsedReason(item, 'radarr')).toBeNull();
  });
});

describe('seed limits', () => {
  const withFields = (fields: Record<string, unknown>) => indexer({ push: { sonarr: { ...indexer().push.sonarr!, fields }, radarr: { ...indexer().push.radarr!, fields } } });

  it('reads the ratio and the time that the indexer asks for', () => {
    const item = withFields({ 'seedCriteria.seedRatio': 1.5, 'seedCriteria.seedTime': 1440, 'seedCriteria.seasonPackSeedTime': 4320 });
    expect(seedLimits(item, 'radarr', false)).toEqual({ ratio: 1.5, minutes: 1440 });
    expect(seedLimits(item, 'sonarr', false)).toEqual({ ratio: 1.5, minutes: 1440 });
    expect(seedLimits(item, 'sonarr', true)).toEqual({ ratio: 1.5, minutes: 4320 });
  });

  it('gives no limit when the values are empty or not valid', () => {
    expect(seedLimits(withFields({}), 'sonarr', false)).toBeNull();
    expect(seedLimits(withFields({ 'seedCriteria.seedRatio': null, 'seedCriteria.seedTime': 0 }), 'sonarr', false)).toBeNull();
    expect(seedLimits(withFields({ 'seedCriteria.seedRatio': 'x', 'seedCriteria.seedTime': -5 }), 'sonarr', false)).toBeNull();
    expect(seedLimits(withFields({ 'seedCriteria.seasonPackSeedTime': null, 'seedCriteria.seedTime': 60 }), 'sonarr', true)).toEqual({ ratio: null, minutes: 60 });
  });
});
