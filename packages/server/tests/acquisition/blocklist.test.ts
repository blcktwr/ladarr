import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/test-app.ts';
import { title } from '../helpers/test-fixtures.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
  app.db.data.titles['tv:3'] = title({ key: 'tv:3', tmdbId: 3, meta: { ...title().meta, tmdbId: 3, title: 'Another Show', originalTitle: 'Another Show' } });
});
afterAll(() => app.close());

const fill = () => {
  app.db.data.blocklist = {
    '0123456789abcdef0123456789abcdef01234567': { title: 'Show.S01E01.WEB-DL-AAA', reason: 'invalid_torrent', at: 1_000, titleKey: 'tv:1' },
    // A key that has characters which do not fit in a path.
    '4:https://tracker/dl?a=1&b=2/x y': { title: 'Show.S01E02.WEB-DL-BBB', reason: 'pack_missing_episodes', at: 3_000, titleKey: 'tv:2' },
    // An entry from a version that had no title for each entry. The name of its release gives the title.
    '4:guid-3': { title: 'Another.Show.S01E03.WEB-DL-CCC', reason: 'something_new', at: 2_000 },
  };
};

describe('blocklist API', () => {
  it('lists the newest first, with a text for each reason', async () => {
    fill();
    const { body } = await app.get('/blocklist');
    expect(body.total).toBe(3);
    expect(body.items.map((item: { title: string }) => item.title)).toEqual(['Show.S01E02.WEB-DL-BBB', 'Another.Show.S01E03.WEB-DL-CCC', 'Show.S01E01.WEB-DL-AAA']);
    expect(body.items[0].reason).toEqual({ code: 'pack_missing_episodes', message: expect.stringContaining('season pack') });
    // A reason that ladarr does not know still has a text.
    expect(body.items[1].reason.message).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('guid-3');
  });

  it('pages the list', async () => {
    fill();
    const { body } = await app.get('/blocklist?limit=2&offset=2');
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(1);
  });

  it('lists only the entries of one title', async () => {
    fill();
    const first = await app.get('/blocklist?titleKey=tv:1');
    expect(first.body.total).toBe(1);
    expect(first.body.items.map((item: { title: string }) => item.title)).toEqual(['Show.S01E01.WEB-DL-AAA']);
    const second = await app.get('/blocklist?titleKey=tv:2');
    expect(second.body.total).toBe(1);
    expect(second.body.items.map((item: { title: string }) => item.title)).toEqual(['Show.S01E02.WEB-DL-BBB']);
    // An entry that has no title is the entry of the title that its release names.
    const third = await app.get('/blocklist?titleKey=tv:3');
    expect(third.body.total).toBe(1);
    expect(third.body.items.map((item: { title: string }) => item.title)).toEqual(['Another.Show.S01E03.WEB-DL-CCC']);
    expect((await app.get('/blocklist?titleKey=tv:9')).body).toEqual({ total: 0, items: [] });
  });

  it('does not list an entry that names no title', async () => {
    fill();
    app.db.data.blocklist['4:guid-5'] = { title: 'Unknown.Show.S01E05.WEB-DL-EEE', reason: 'invalid_torrent', at: 5_000 };
    for (const key of ['tv:1', 'tv:2', 'tv:3']) {
      const { body } = await app.get(`/blocklist?titleKey=${key}`);
      expect(body.items.map((item: { title: string }) => item.title)).not.toContain('Unknown.Show.S01E05.WEB-DL-EEE');
    }
  });

  it('pages the entries of one title', async () => {
    fill();
    app.db.data.blocklist['4:guid-4'] = { title: 'Show.S01E04.WEB-DL-DDD', reason: 'invalid_torrent', at: 4_000, titleKey: 'tv:2' };
    const { body } = await app.get('/blocklist?titleKey=tv:2&limit=1&offset=1');
    expect(body.total).toBe(2);
    expect(body.items.map((item: { title: string }) => item.title)).toEqual(['Show.S01E02.WEB-DL-BBB']);
  });

  it('removes the entries of one title, and only those', async () => {
    fill();
    expect((await app.del('/blocklist?titleKey=tv:1')).body).toEqual({ removed: 1 });
    expect(app.db.data.blocklist['0123456789abcdef0123456789abcdef01234567']).toBeUndefined();
    // The entry of the other title, and the entry that has no title of its own, stay.
    expect(app.db.data.blocklist['4:https://tracker/dl?a=1&b=2/x y']).toBeDefined();
    expect(app.db.data.blocklist['4:guid-3']).toBeDefined();
    expect(Object.keys(app.db.data.blocklist)).toHaveLength(2);
    // An entry that has no title goes with the title that its release names.
    expect((await app.del('/blocklist?titleKey=tv:3')).body).toEqual({ removed: 1 });
    expect(app.db.data.blocklist['4:guid-3']).toBeUndefined();
    expect(Object.keys(app.db.data.blocklist)).toHaveLength(1);
  });

  it('removes one release by its ID, also when its key has odd characters', async () => {
    fill();
    const { items } = (await app.get('/blocklist')).body;
    expect((await app.del(`/blocklist/${items[0].id}`)).body).toEqual({ removed: 1 });
    expect(Object.keys(app.db.data.blocklist)).toHaveLength(2);
    expect(app.db.data.blocklist['4:https://tracker/dl?a=1&b=2/x y']).toBeUndefined();
    expect((await app.del(`/blocklist/${items[0].id}`)).status).toBe(404);
    expect((await app.del('/blocklist/not-an-id')).status).toBe(404);
  });

  it('clears the whole list', async () => {
    fill();
    expect((await app.del('/blocklist')).body).toEqual({ removed: 3 });
    expect(app.db.data.blocklist).toEqual({});
    expect((await app.get('/blocklist')).body).toEqual({ total: 0, items: [] });
  });

  it('needs a signed-in owner', async () => {
    fill();
    for (const method of ['GET', 'DELETE']) expect((await fetch(`${app.base}/blocklist`, { method })).status).toBe(401);
    expect(Object.keys(app.db.data.blocklist)).toHaveLength(3);
  });
});
