import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyData, withDefaults, type Data } from '../../src/core/db.ts';
import { QUALITIES } from '../../src/library/grab/quality.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { title } from '../helpers/test-fixtures.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

// WEB-DL and WEBRip of 1080p count as one quality.
const mixed = { name: 'Mixed', items: [['bluray-1080'], ['webdl-1080', 'webrip-1080']] };
const ids = (body: { profiles: { id: string }[] }) => body.profiles.map((profile) => profile.id);

describe('quality profiles', () => {
  it('lists every quality with its sizes, and the profiles in the order of the chain', async () => {
    const { body } = await app.get('/quality');
    expect(body.qualities).toHaveLength(QUALITIES.length);
    expect(body.qualities.find((quality: { id: string }) => quality.id === 'webdl-1080')).toMatchObject({ label: 'WEB-DL 1080p', sizes: { min: 15, preferred: 60, max: 150 } });
    expect(ids(body)).toEqual(['p1080', 'p2160']);
  });

  it('appends a new profile to the order, changes it, and removes it from the order on delete', async () => {
    const order = async () => ids((await app.get('/quality')).body);
    const made = await app.post('/quality/profiles', mixed);
    expect(made).toMatchObject({ status: 201, body: { profile: { id: '3', ...mixed } } });
    expect(await order()).toEqual(['p1080', 'p2160', '3']);
    expect((await app.fetchJson('PUT', '/quality/profiles/3', { ...mixed, name: 'Mixed 2' })).body.profile).toMatchObject({ name: 'Mixed 2' });
    expect((await app.post('/quality/profiles', mixed)).body.profile.id).toBe('4');
    expect(await order()).toEqual(['p1080', 'p2160', '3', '4']);

    app.db.data.titles['movie:9'] = title({ key: 'movie:9', preset: '3' });
    expect(await app.del('/quality/profiles/3')).toMatchObject({ status: 409, body: { error: 'profile_in_use', titles: 1 } });
    delete app.db.data.titles['movie:9'];
    expect((await app.del('/quality/profiles/3')).status).toBe(204);
    expect(await order()).toEqual(['p1080', 'p2160', '4']);
    expect((await app.del('/quality/profiles/3')).status).toBe(404);
    expect((await app.del('/quality/profiles/4')).status).toBe(204);
    expect(await order()).toEqual(['p1080', 'p2160']);
  });

  it('sets the order of the profiles', async () => {
    const res = await app.fetchJson('PUT', '/quality/order', { ids: ['p2160', 'p1080'] });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(['p2160', 'p1080']);
    expect(ids((await app.get('/quality')).body)).toEqual(['p2160', 'p1080']);
    expect((await app.fetchJson('PUT', '/quality/order', { ids: ['p1080', 'p2160'] })).status).toBe(200);
  });

  it.each([
    [{ ids: ['p1080'] }],
    [{ ids: ['p1080', 'p2160', 'nope'] }],
    [{ ids: ['p1080', 'p1080'] }],
    [{ ids: 'nope' }],
    [{}],
  ])('rejects the order %j', async (body) => {
    expect(await app.fetchJson('PUT', '/quality/order', body)).toMatchObject({ status: 400, body: { error: 'invalid_order' } });
  });

  it('does not take a default profile in the settings', async () => {
    expect(await app.patch('/settings', { defaultPreset: 'p1080' })).toMatchObject({ status: 400, body: { error: 'invalid_setting', field: 'defaultPreset' } });
  });

  it.each([
    [{ ...mixed, name: ' ' }, 'name'],
    [{ ...mixed, items: [] }, 'items'],
    [{ ...mixed, items: [[]] }, 'items'],
    [{ ...mixed, items: [['nope']] }, 'items'],
    [{ ...mixed, items: [['webdl-1080'], ['webdl-1080']] }, 'items'],
  ])('rejects %j', async (body, field) => {
    expect(await app.post('/quality/profiles', body)).toMatchObject({ status: 400, body: { error: 'invalid_profile', field } });
  });

  it('saves a profile with only its id, name, and items', async () => {
    const other = await startTestApp();
    try {
      const made = await other.post('/quality/profiles', mixed);
      expect(made.status).toBe(201);
      expect(made.body.profile).toMatchObject(mixed);
      expect(Object.keys(made.body.profile).sort()).toEqual(['id', 'items', 'name']);
    } finally {
      other.close();
    }
  });

  it('does not find a profile that is not saved', async () => {
    expect((await app.fetchJson('PUT', '/quality/profiles/constructor', mixed)).status).toBe(404);
  });
});

describe('a chain with one profile', () => {
  it('does not delete the last profile', async () => {
    const other = await startTestApp();
    try {
      other.db.data.profiles = { p1080: other.db.data.profiles.p1080! };
      other.db.data.profileOrder = ['p1080'];
      expect(await other.del('/quality/profiles/p1080')).toMatchObject({ status: 409, body: { error: 'last_profile' } });
      expect(ids((await other.get('/quality')).body)).toEqual(['p1080']);
    } finally {
      other.close();
    }
  });

  it('has no default profile that the delete must keep', async () => {
    const other = await startTestApp();
    try {
      expect((await other.del('/quality/profiles/p1080')).status).toBe(204);
      expect(ids((await other.get('/quality')).body)).toEqual(['p2160']);
    } finally {
      other.close();
    }
  });
});

describe('sizes of a quality', () => {
  it('saves limits in order, and a limit that is null is not checked', async () => {
    expect((await app.fetchJson('PUT', '/quality/sizes/hdtv-720', { min: 10, preferred: null, max: 50 })).body.sizes).toEqual({ min: 10, preferred: null, max: 50 });
    expect(app.db.data.qualitySizes['hdtv-720']).toEqual({ min: 10, preferred: null, max: 50 });
  });

  it.each([
    [{ min: 10, preferred: 5, max: 50 }],
    [{ min: 10, preferred: 20, max: 15 }],
    [{ min: -1, preferred: null, max: null }],
    [{ min: '1', preferred: null, max: null }],
    [{ preferred: null, max: null }],
  ])('rejects %j', async (body) => {
    expect((await app.fetchJson('PUT', '/quality/sizes/hdtv-720', body)).status).toBe(400);
  });

  it('does not find a quality that is not on the list', async () => {
    expect((await app.fetchJson('PUT', '/quality/sizes/nope', { min: 1, preferred: null, max: null })).status).toBe(404);
  });
});

describe('a data file of version 1', () => {
  it('starts the chain with the two profiles of version 1', () => {
    expect(emptyData().profileOrder).toEqual(['p1080', 'p2160']);
  });

  it('moves the old default profile to the first entry of the order, and removes the setting', () => {
    const old = emptyData() as Data & { settings: { defaultPreset?: string } };
    delete (old as Partial<Data>).profileOrder;
    old.settings.defaultPreset = 'p2160';
    const data = withDefaults(old);
    expect(data.profileOrder).toEqual(['p2160', 'p1080']);
    expect(data.settings).not.toHaveProperty('defaultPreset');
  });

  it('drops an order entry of a missing profile and appends the profiles that it lacks', () => {
    const old = emptyData();
    old.profileOrder = ['gone', 'p2160'];
    const data = withDefaults(old);
    expect(data.profileOrder).toEqual(['p2160', 'p1080']);
  });
});
