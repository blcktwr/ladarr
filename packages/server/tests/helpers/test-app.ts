import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { open, set, type Db } from '../../src/core/db.ts';

// Starts the app on a free port with a signed-in owner. For tests only.
export async function startTestApp(options: Parameters<typeof createApp>[0] = {}, existing?: Db) {
  const db: Db = existing ?? (await open('unused.json'));
  set(db);
  const server = createApp(options).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  const setup = await fetch(`${base}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse' }),
  });
  const cookie = setup.headers.getSetCookie()[0]!.split(';')[0]!;
  const { csrfToken } = await (await fetch(`${base}/auth/status`, { headers: { cookie } })).json();

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }

  return {
    db,
    base,
    cookie,
    get: (path: string) => call('GET', path),
    post: (path: string, body: unknown = {}) => call('POST', path, body),
    patch: (path: string, body: unknown) => call('PATCH', path, body),
    del: (path: string) => call('DELETE', path),
    fetchJson: call,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
