import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { outboundFetch } from '../../src/core/http.ts';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { outboundRequests, withOutboundRequests } from '../../src/core/outbound.ts';

const dirs: string[] = [];

// Each test writes to its own file, so no entry of another test lands in it.
function useLog(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `ladarr-http-${name}-`));
  dirs.push(dir);
  logToFile(join(dir, 'ladarr.log'));
}

async function readEntries() {
  await closeLog();
  return recentLogs(50, { kind: 'requests' });
}

afterEach(async () => {
  await closeLog();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const answer = (response: Response) => (async () => response.clone()) as unknown as typeof fetch;
const thrower = (error: unknown) =>
  (async () => {
    throw error;
  }) as unknown as typeof fetch;

describe('outboundFetch', () => {
  it('logs the request with its full address and the answer with its body', async () => {
    useLog('success');
    const response = new Response('{"results":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    const send = outboundFetch('TMDB', answer(response));

    await expect(send('https://api.themoviedb.org/3/search/movie?query=The%20Matrix')).resolves.toBeInstanceOf(Response);

    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: 'outbound request',
      system: 'TMDB',
      request: {
        method: 'GET',
        url: 'https://api.themoviedb.org/3/search/movie?query=The%20Matrix',
        headers: {},
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { results: [] },
      },
    });
    expect(entries[0]).not.toHaveProperty('ms');
  });

  it('takes the method and the body from the init', async () => {
    useLog('method');
    const send = outboundFetch('Download client qBittorrent', answer(new Response('Ok.', { status: 200 })));

    await send('http://127.0.0.1:8080/api/v2/auth/login', { method: 'post', body: new URLSearchParams({ username: 'admin', password: 'secret' }) });

    expect((await readEntries())[0]).toMatchObject({
      request: { method: 'POST', url: 'http://127.0.0.1:8080/api/v2/auth/login', body: { username: 'admin', password: '[redacted]' } },
      response: { status: 200, body: 'Ok.' },
    });
  });

  it('takes the method and the address of a Request', async () => {
    useLog('request');
    const send = outboundFetch('Indexer', answer(new Response('<caps/>', { status: 200 })));

    await send(new Request('https://indexer.test/api?t=caps'));

    expect((await readEntries())[0]).toMatchObject({ request: { method: 'GET', url: 'https://indexer.test/api?t=caps' }, response: { status: 200, body: '<caps/>' } });
  });

  it('uses the path of the options, in place of the path of the address', async () => {
    useLog('path');
    const send = outboundFetch('Webhook', answer(new Response(null, { status: 204 })), { path: '[hidden]' });

    await send('https://hooks.example.com/hook/token', { method: 'POST' });

    expect((await readEntries())[0]).toMatchObject({ request: { url: '[hidden]', method: 'POST' }, response: { status: 204 } });
  });

  it('leaves the query out when the options turn it off', async () => {
    useLog('query');
    const send = outboundFetch('Webhook', answer(new Response(null, { status: 204 })), { path: '[hidden]', query: false });

    await send('https://hooks.example.com/hook/token?token=supersecret', { method: 'POST' });

    const [entry] = await readEntries();
    expect(entry).toMatchObject({ message: 'outbound request', request: { url: '[hidden]' }, response: { status: 204 } });
    expect(JSON.stringify(entry)).not.toContain('supersecret');
  });

  it('logs the code of a failed request and throws the same error', async () => {
    useLog('failure');
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const send = outboundFetch('Indexer', thrower(refused));

    await expect(send('https://indexer.test/api?t=caps')).rejects.toBe(refused);

    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: 'outbound request failed',
      system: 'Indexer',
      request: { method: 'GET', url: 'https://indexer.test/api?t=caps' },
      code: 'ECONNREFUSED',
    });
    expect(entries[0]).not.toHaveProperty('response');
  });

  it('uses the name of the error when it has no code', async () => {
    useLog('name');
    const broken = new Error('boom');
    const send = outboundFetch('Migration source', thrower(broken));

    await expect(send('https://sonarr.test/api/v3/system/status')).rejects.toBe(broken);

    expect((await readEntries())[0]).toMatchObject({ message: 'outbound request failed', code: 'Error', request: { url: 'https://sonarr.test/api/v3/system/status' } });
  });

  it('tags the success entry with the id of the request', async () => {
    useLog('request-id');
    const send = outboundFetch('Indexer', answer(new Response('<caps/>', { status: 200 })), { requestId: 'req-1' });

    await send('https://indexer.test/api?t=caps');

    expect(await readEntries()).toMatchObject([{ message: 'outbound request', requestId: 'req-1' }]);
  });

  it('tags the failure entry with the id of the request', async () => {
    useLog('request-id-failure');
    const refused = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const send = outboundFetch('Indexer', thrower(refused), { requestId: 'req-1' });

    await expect(send('https://indexer.test/api?t=caps')).rejects.toBe(refused);

    expect(await readEntries()).toMatchObject([{ message: 'outbound request failed', requestId: 'req-1' }]);
  });

  it('gives every system of the work one id, and shares it between its requests', async () => {
    useLog('scope');
    const tmdb = outboundFetch('TMDB', answer(new Response('{}', { status: 200 })));
    const client = outboundFetch('Download client qBittorrent', answer(new Response('Ok.', { status: 200 })));

    const made = await withOutboundRequests(async () => {
      await tmdb('https://api.test/one');
      await tmdb('https://api.test/two');
      await client('http://127.0.0.1:8080/api/v2/app/version');
      return outboundRequests();
    });

    expect(made).toEqual([
      { requestId: expect.stringMatching(/^req-[0-9a-f]{12}$/), system: 'TMDB' },
      { requestId: expect.stringMatching(/^req-[0-9a-f]{12}$/), system: 'Download client qBittorrent' },
    ]);
    const entries = await readEntries();
    expect(entries.map((entry) => entry.requestId)).toEqual([made[0]!.requestId, made[0]!.requestId, made[1]!.requestId]);
  });

  it('keeps no request outside a work', async () => {
    useLog('no-scope');
    const send = outboundFetch('TMDB', answer(new Response('{}', { status: 200 })));

    await send('https://api.test/one');

    expect(outboundRequests()).toEqual([]);
  });

  it('hides a secret value in the query', async () => {
    useLog('secret');
    const send = outboundFetch('TMDB', answer(new Response('{}', { status: 200 })));

    await send('https://api.themoviedb.org/3/search/movie?query=The%20Matrix&api_key=secret-key-1234&page=2');

    const entries = await readEntries();
    expect(entries[0]).toMatchObject({ request: { url: 'https://api.themoviedb.org/3/search/movie?query=The%20Matrix&api_key=[redacted]&page=2' } });
    expect(JSON.stringify(entries)).not.toContain('secret-key-1234');
  });
});
