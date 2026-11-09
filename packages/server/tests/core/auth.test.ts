import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { openDb, type Db } from '../../src/core/db.ts';

let db: Db;
let base = '';
let close: () => void;

beforeAll(async () => {
  db = await openDb('unused.json');
  const server = createApp(db).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  close = () => server.close();
});
afterAll(() => close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const credentials = { password: 'correct horse' };
let cookie = '';
let csrfToken = '';

describe('auth', () => {
  it('rejects unauthenticated API access', async () => {
    expect((await fetch(`${base}/anything`)).status).toBe(401);
  });

  it('rejects a setup without a password', async () => {
    const res = await post('/auth/setup', {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_credentials_format' });
  });

  it('rejects a setup with a short password', async () => {
    const res = await post('/auth/setup', { password: 'abc' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_credentials_format' });
  });

  it('lets only one of many concurrent setup requests create the owner', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => post('/auth/setup', credentials)));
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    cookie = responses.find((r) => r.status === 201)!.headers.getSetCookie()[0]!.split(';')[0]!;
    const status = await (await fetch(`${base}/auth/status`, { headers: { cookie } })).json();
    expect(status).toMatchObject({ setupRequired: false, authenticated: true });
    csrfToken = status.csrfToken;
    const owner = db.data.owner;
    expect(owner).toMatchObject({ passwordHash: expect.any(String), createdAt: expect.any(Number) });
    expect(owner).not.toHaveProperty('username');
  });

  it('keeps setup closed after completion', async () => {
    expect((await post('/auth/setup', { password: 'another password' })).status).toBe(409);
  });

  it('lets the owner change the password during setup', async () => {
    const createdAt = db.data.owner!.createdAt;

    const anonymous = await post('/auth/setup', { password: 'another password' });
    expect(anonymous.status).toBe(409);
    expect(await anonymous.json()).toEqual({ error: 'setup_closed' });

    const noToken = await post('/auth/setup', { password: 'another password' }, { cookie });
    expect(noToken.status).toBe(403);
    expect(await noToken.json()).toEqual({ error: 'invalid_csrf_token' });

    const wrongToken = await post('/auth/setup', { password: 'another password' }, { cookie, 'x-csrf-token': 'wrong' });
    expect(wrongToken.status).toBe(403);
    expect(await wrongToken.json()).toEqual({ error: 'invalid_csrf_token' });

    const changed = await post('/auth/setup', { password: 'another password' }, { cookie, 'x-csrf-token': csrfToken });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ ok: true });
    expect(db.data.owner!.createdAt).toBe(createdAt);

    expect((await post('/auth/login', { password: credentials.password })).status).toBe(401);
    expect((await post('/auth/login', { password: 'another password' })).status).toBe(200);
    credentials.password = 'another password';
  });

  it('closes the password change once setup is complete', async () => {
    db.data.settings.setupCompleted = true;
    try {
      expect((await post('/auth/setup', { password: 'a third password' }, { cookie, 'x-csrf-token': csrfToken })).status).toBe(409);
    } finally {
      db.data.settings.setupCompleted = false;
    }
  });

  it('serves the session cookie to protected routes', async () => {
    expect((await fetch(`${base}/anything`, { headers: { cookie } })).status).toBe(404);
  });

  it('requires the CSRF token on unsafe methods', async () => {
    expect((await post('/auth/logout', {}, { cookie })).status).toBe(403);
  });

  it('requires a JSON body for login', async () => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
  });

  it('shows the API key to the session, and accepts it in X-Api-Key', async () => {
    const { apiKey } = await (await fetch(`${base}/auth/api-key`, { headers: { cookie } })).json();
    expect(apiKey).toMatch(/\S{20,}/);
    expect((await fetch(`${base}/anything`, { headers: { 'x-api-key': apiKey } })).status).toBe(404);
    expect((await fetch(`${base}/anything`, { headers: { 'x-api-key': 'wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/auth/api-key`, { headers: { 'x-api-key': apiKey } })).status).toBe(401);
  });

  it('rotates the API key and rejects the old one', async () => {
    const { apiKey: oldKey } = await (await fetch(`${base}/auth/api-key`, { headers: { cookie } })).json();
    expect((await post('/auth/api-key/rotate', {}, { cookie })).status).toBe(403);
    const rotated = await post('/auth/api-key/rotate', {}, { cookie, 'x-csrf-token': csrfToken });
    const { apiKey: newKey } = await rotated.json();
    expect(newKey).not.toBe(oldKey);
    expect((await fetch(`${base}/anything`, { headers: { 'x-api-key': oldKey } })).status).toBe(401);
    expect((await fetch(`${base}/anything`, { headers: { 'x-api-key': newKey } })).status).toBe(404);
  });

  it('logs out and drops the session', async () => {
    expect((await post('/auth/logout', {}, { cookie, 'x-csrf-token': csrfToken })).status).toBe(200);
    expect((await fetch(`${base}/anything`, { headers: { cookie } })).status).toBe(401);
  });

  it('logs in with the right password', async () => {
    expect((await post('/auth/login', credentials)).status).toBe(200);
  });

  it('throttles repeated failed logins', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post('/auth/login', { password: 'wrong password' })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});
