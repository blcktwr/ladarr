import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyData, openDb } from '../../src/core/db.ts';
import { startTestApp } from '../helpers/test-app.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

describe('naming settings', () => {
  it('starts with the default names', async () => {
    const { settings } = (await app.get('/settings')).body;
    expect(settings.naming).toEqual({ movie: '{title} ({year})', episode: '{title} - S{season}E{episode} - {episodeTitle}' });
  });

  it('saves valid templates', async () => {
    const naming = { movie: '{title} [{year}]', episode: '{title} S{season}E{episode}' };
    expect((await app.patch('/settings', { naming })).status).toBe(200);
    expect((await app.get('/settings')).body.settings).toMatchObject({ naming });
    expect((await app.patch('/settings', { naming: { movie: '{title} ({year})', episode: '{title} - S{season}E{episode} - {episodeTitle}' } })).status).toBe(200);
  });

  it.each([
    [{ naming: { movie: '{title}/{year}', episode: '{title} S{season}E{episode}' } }, 'naming'],
    // A rescan can not read the season and the episodes from these names.
    [{ naming: { movie: '{title}', episode: '{title} {season}x{episode}' } }, 'naming'],
    [{ naming: { movie: '{title}', episode: '{title}' } }, 'naming'],
    [{ naming: { movie: '{title}' } }, 'naming'],
  ])('refuses %j', async (change, field) => {
    const before = (await app.get('/settings')).body.settings;
    const refused = await app.patch('/settings', change);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'invalid_setting', field });
    expect((await app.get('/settings')).body.settings).toEqual(before);
  });
});

describe('a database from an older version', () => {
  it('gets the default names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-old-'));
    try {
      // The settings of an older version have no naming.
      const { naming: _naming, ...old } = emptyData().settings;
      writeFileSync(join(dir, 'db.json'), JSON.stringify({ ...emptyData(), settings: { ...old, recoveryDays: 3 } }));
      // lowdb keeps the data in memory when it runs in a test. This test needs the file.
      vi.stubEnv('NODE_ENV', 'production');
      const db = await openDb(join(dir, 'db.json'));
      expect(db.data.settings).toMatchObject({ naming: emptyData().settings.naming });
      expect(db.data.settings).not.toHaveProperty('recoveryDays');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
