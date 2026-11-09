import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { openDb } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';

const events = createEvents(3);
let base = '';
let cookie = '';
let close: () => void;

beforeAll(async () => {
  const db = await openDb('unused.json');
  const server = createApp(db, { events }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  close = () => {
    server.closeAllConnections();
    server.close();
  };
  const setup = await fetch(`${base}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse' }),
  });
  cookie = setup.headers.getSetCookie()[0]!.split(';')[0]!;
});
afterAll(() => close());

// Reads the stream until it has `count` frames, then closes it.
async function listen(headers: Record<string, string>, count: number, publishAfterOpen?: () => void) {
  const abort = new AbortController();
  const res = await fetch(`${base}/events`, { headers: { cookie, ...headers }, signal: abort.signal });
  publishAfterOpen?.();
  const reader = res.body!.getReader();
  let text = '';
  while (text.split('\n\n').filter((part) => part.startsWith('id:') || part.startsWith('event:')).length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  abort.abort();
  return text.split('\n\n').filter(Boolean).map((part) => Object.fromEntries(part.split('\n').map((line) => line.split(/: (.*)/s).slice(0, 2))));
}

describe('events', () => {
  it('rejects a request without a session', async () => {
    expect((await fetch(`${base}/events`)).status).toBe(401);
  });

  it('sends a published event to a connected client', async () => {
    const [first] = await listen({}, 1, () => events.publish('title.changed', { id: 1 }));
    expect(first).toMatchObject({ event: 'title.changed', data: '{"id":1}' });
  });

  it('replays what a reconnecting client missed', async () => {
    const [seen] = await listen({}, 1, () => events.publish('a'));
    events.publish('b');
    const replay = await listen({ 'last-event-id': seen!.id! }, 1);
    expect(replay[0]).toMatchObject({ event: 'b' });
  });

  it('asks for a resync when the replay window no longer holds the missed events', async () => {
    const [seen] = await listen({}, 1, () => events.publish('c'));
    for (let i = 0; i < 5; i++) events.publish('x');
    expect((await listen({ 'last-event-id': seen!.id! }, 1))[0]).toMatchObject({ event: 'resync' });
  });

  it('asks for a resync after a restart', async () => {
    expect((await listen({ 'last-event-id': 'old-boot:7' }, 1))[0]).toMatchObject({ event: 'resync' });
  });
});
