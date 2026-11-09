import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/core/db.ts';
import { until } from './helpers/test-pipeline.ts';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ladarr-stop-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe('stop signal', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('stops the real server with exit code 0 and saved data on %s', async (signal) => {
    const configDir = join(dir, signal);
    const port = await freePort();
    // Vitest sets NODE_ENV to "test", and then lowdb keeps the data in memory only.
    const child = spawn(process.execPath, [entry], { env: { ...process.env, NODE_ENV: 'production', PORT: String(port), LADARR_CONFIG_DIR: configDir, LADARR_TMDB_BASE_URL: 'http://127.0.0.1:1' }, stdio: 'ignore' });
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));

    let ready = false;
    await until(() => {
      void fetch(`http://127.0.0.1:${port}/api/health`).then((res) => (ready = res.ok), () => {});
      return ready;
    });
    child.kill(signal);
    expect(await exit).toBe(0);

    const log = readFileSync(join(configDir, 'logs', 'ladarr.log'), 'utf8');
    expect(log).toContain('server stopping');
    expect(log).toContain('server stopped');
    const data = JSON.parse(readFileSync(join(configDir, 'db.json'), 'utf8'));
    expect(data.schemaVersion).toBe(SCHEMA_VERSION);
    // The queue work lives in its own file.
    const queue = JSON.parse(readFileSync(join(configDir, 'queue.json'), 'utf8'));
    // No job keeps a lease after a clean stop.
    expect(Object.values<{ state: string; leaseOwner: string | null }>(queue.jobs).filter((job) => job.state === 'running' || job.leaseOwner)).toEqual([]);
  }, 20_000);
});
