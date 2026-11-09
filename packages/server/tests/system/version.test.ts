import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, checkForUpdate, isNewerVersion } from '../../src/system/version.ts';

const URL_LATEST = 'https://api.github.com/repos/blcktwr/ladarr/releases/latest';
const HTML_URL = 'https://github.com/blcktwr/ladarr/releases/tag/v9.9.9';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The fake GitHub answers with a fixed response and records every request.
function fakeGithub(respond: () => Response | Promise<Response>) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const send = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return respond();
  }) as typeof fetch;
  return { send, calls };
}

const release = (tag: string) => json({ tag_name: tag, html_url: HTML_URL });

describe('installed version', () => {
  it('is the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });
});

describe('check for update', () => {
  it('asks the GitHub releases endpoint with the accept and user-agent headers', async () => {
    const { send, calls } = fakeGithub(() => release('v9.9.9'));
    await checkForUpdate(send);

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url.href).toBe(URL_LATEST);
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('user-agent')).toBeTruthy();
  });

  it('reports a newer release with the tag without the leading v and its url', async () => {
    const { send } = fakeGithub(() => release('v9.9.9'));
    expect(await checkForUpdate(send)).toEqual({ available: true, latest: '9.9.9', url: HTML_URL });
  });

  it('reports no update for the installed version', async () => {
    const { send } = fakeGithub(() => release(`v${APP_VERSION}`));
    expect((await checkForUpdate(send)).available).toBe(false);
  });

  it('reports no update for an older release', async () => {
    const { send } = fakeGithub(() => release('v0.0.1'));
    expect((await checkForUpdate(send)).available).toBe(false);
  });

  it('throws on a response that is not ok', async () => {
    const { send } = fakeGithub(() => json({ message: 'Not Found' }, 404));
    await expect(checkForUpdate(send)).rejects.toThrow();
  });

  it('throws when the request fails', async () => {
    const { send } = fakeGithub(() => {
      throw new Error('offline');
    });
    await expect(checkForUpdate(send)).rejects.toThrow();
  });

  it('throws when the body has no tag_name', async () => {
    const { send } = fakeGithub(() => json({ html_url: HTML_URL }));
    await expect(checkForUpdate(send)).rejects.toThrow();
  });

  it('throws when the body has no html_url', async () => {
    const { send } = fakeGithub(() => json({ tag_name: 'v9.9.9' }));
    await expect(checkForUpdate(send)).rejects.toThrow();
  });
});

describe('version comparison', () => {
  it('follows dotted numeric order', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('V0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('1.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '1')).toBe(false);
  });
});
