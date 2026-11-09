import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from '../helpers/test-app.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeEach(async () => {
  app = await startTestApp();
});
afterEach(() => app.close());

const alerts = async () => (await app.get('/alerts')).body.alerts as { id: string; title: string; message: string; params?: Record<string, string | number> }[];

const problems = [
  { id: 'problem:indexers_missing', title: 'No indexer is set.', message: 'Add an indexer in Settings.' },
  { id: 'problem:metadata_missing', title: 'No metadata provider is connected.', message: 'Set TMDB_API_KEY and start the server again.' },
];

describe('alerts', () => {
  it('turns each problem into an alert, in the order of the problems', async () => {
    expect(await alerts()).toEqual(problems);
  });

  it('leaves out a stopped target', async () => {
    app.db.data.queue['movie:1'] = { id: 'movie:1', reason: { code: 'no_results' }, branch: null } as never;
    expect(await alerts()).toEqual(problems);
  });

  it('leaves out the problems of a library folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-alerts-'));
    const path = join(dir, 'movies');
    mkdirSync(path);
    try {
      const added = await app.post('/roots', { path, mediaType: 'movie' });
      rmSync(path, { recursive: true });
      // The folder problem stays in the status of the system.
      expect((await app.get('/system/status')).body.problems.map((problem: { id: string }) => problem.id)).toContain(`root_not_found:${added.body.id}`);
      expect(await alerts()).toEqual(problems);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('needs a session', async () => {
    expect((await fetch(`${app.base}/alerts`)).status).toBe(401);
  });
});
