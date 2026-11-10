import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { open } from '../src/core/db.ts';

const dir = mkdtempSync(join(tmpdir(), 'ladarr-web-'));
let origin = '';
let close: () => void;

beforeAll(async () => {
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<html><head><base href="/" /></head><body>app</body></html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  await open('unused.json');
  const server = createApp({ urlBase: '/ladarr', webDir: dir }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => {
  close();
  rmSync(dir, { recursive: true });
});

describe('health', () => {
  it('reports a stalled worker with a 503', async () => {
    await open('unused.json');
    const server = createApp({ heartbeat: () => Date.now() - 60_000 }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`);
    server.close();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'worker_stalled' });
  });
});

describe('url base', () => {
  it('serves the page for any app path, with the base tag set', async () => {
    for (const path of ['/ladarr', '/ladarr/', '/ladarr/settings']) {
      const html = await (await fetch(`${origin}${path}`)).text();
      expect(html).toContain('<base href="/ladarr/" />');
    }
  });

  it('serves assets and the API under the base only', async () => {
    expect(await (await fetch(`${origin}/ladarr/assets/app.js`)).text()).toBe('console.log(1)');
    expect((await fetch(`${origin}/ladarr/api/health`)).status).toBe(200);
    expect((await fetch(`${origin}/api/health`)).status).toBe(404);
  });

  it('does not answer a missing asset with the page', async () => {
    expect((await fetch(`${origin}/ladarr/assets/missing.js`)).status).toBe(404);
  });

  it('keeps unknown API paths as JSON errors', async () => {
    const res = await fetch(`${origin}/ladarr/api/nothing`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('json');
  });
});
