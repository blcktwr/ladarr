import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup } from '../../src/system/backup.ts';
import { startTestApp } from '../helpers/test-app.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
let dir: string;
let heartbeat = Date.now();

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-health-')));
  mkdirSync(join(dir, 'movies'));
  app = await startTestApp({ backupDir: join(dir, 'backups'), heartbeat: () => heartbeat });
});
afterAll(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

const problems = async () => ((await app.get('/system/status')).body.problems as { id: string; message: string; action: string; params?: Record<string, string | number>; fix?: unknown }[]);
const ids = async () => (await problems()).map((p) => p.id);

describe('health problems', () => {
  it('reports a missing provider and a missing backup, each with an action', async () => {
    const found = await problems();
    expect(found.map((p) => p.id)).toEqual(['backup_stale', 'indexers_missing', 'metadata_missing']);
    expect(found.every((p) => p.message && p.action)).toBe(true);
  });

  it('stops reporting the backup after one is made', async () => {
    await app.post('/backups');
    expect(await ids()).toEqual(['indexers_missing', 'metadata_missing']);
  });

  it('reports an indexer that fails, with an action', async () => {
    app.db.data.indexers[1] = { id: 1, baseUrl: 'http://indexer/1/', apiPath: '/api', apiKey: 'k', delaySeconds: 6, nextRequestAt: 0, push: { sonarr: { name: 'Tracker', enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, priority: 25, categories: [5030], animeCategories: [], minimumSeeders: 1, tags: [], fields: {} } }, caps: null, capsAt: 0, health: { okAt: null, failedAt: 1, failures: 2, retryAt: 0, error: 'x' } };
    const found = await problems();
    expect(found.map((p) => p.id)).toContain('indexer_failing:1');
    expect(found.map((p) => p.id)).not.toContain('indexers_missing');
    expect(found.find((p) => p.id === 'indexer_failing:1')!.params).toEqual({ name: 'Tracker' });
    delete app.db.data.indexers[1];
  });

  it('reports a stalled worker', async () => {
    heartbeat = Date.now() - 60_000;
    expect(await ids()).toContain('worker_stalled');
    heartbeat = Date.now();
    expect(await ids()).not.toContain('worker_stalled');
  });

  it('reports a folder that disappears, and keeps the titles that use it', async () => {
    const added = await app.post('/roots', { path: join(dir, 'movies'), mediaType: 'movie' });
    app.db.data.titles['movie:1'] = { rootId: added.body.id } as never;
    expect(await ids()).not.toContain(`root_not_found:${added.body.id}`);

    rmSync(join(dir, 'movies'), { recursive: true });
    const found = await problems();
    const problem = found.find((p) => p.id === `root_not_found:${added.body.id}`);
    expect(problem?.params).toEqual({ path: join(dir, 'movies') });
    // The record and the title stay. A missing mount is not a deletion.
    expect(app.db.data.roots[added.body.id]).toBeDefined();
    expect(app.db.data.titles['movie:1']).toBeDefined();
    delete app.db.data.titles['movie:1'];
    await app.del(`/roots/${added.body.id}`).catch(() => {});
  });

  it('reports a changed mount, and clears it when the user accepts the disk', async () => {
    mkdirSync(join(dir, 'series'));
    const added = await app.post('/roots', { path: join(dir, 'series'), mediaType: 'tv' });
    const root = app.db.data.roots[added.body.id]!;
    const real = root.dev;
    root.dev = real + 1;

    const found = (await problems()).find((p) => p.id === `root_mount_changed:${root.id}`);
    expect(found?.fix).toEqual({ kind: 'accept_mount', rootId: root.id });

    expect((await app.post(`/roots/${root.id}/accept-mount`)).status).toBe(200);
    expect(root.dev).toBe(real);
    expect(await ids()).not.toContain(`root_mount_changed:${root.id}`);
  });

  it('does not accept a mount for a folder that is gone', async () => {
    const root = Object.values(app.db.data.roots).find((r) => r.mediaType === 'tv')!;
    rmSync(root.path, { recursive: true });
    expect((await app.post(`/roots/${root.id}/accept-mount`)).status).toBe(409);
    expect((await app.post('/roots/unknown/accept-mount')).status).toBe(404);
  });
});

describe('backup problem', () => {
  it('shows again when the newest backup is older than two days', async () => {
    const old = await startTestApp({ backupDir: join(dir, 'old-backups') });
    try {
      await createBackup(join(dir, 'old-backups'), 'auto', new Date(Date.now() - 3 * 24 * 60 * 60_000));
      const found = (await old.get('/system/status')).body.problems.map((p: { id: string }) => p.id);
      expect(found).toContain('backup_stale');
    } finally {
      old.close();
    }
  });
});
