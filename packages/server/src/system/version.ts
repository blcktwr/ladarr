import type { UpdateCheck } from '@ladarr/shared/types';
import { readFileSync } from 'node:fs';

export const RELEASE_URL = 'https://api.github.com/repos/blcktwr/ladarr/releases/latest';
export const RELEASE_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'ladarr' };
const MAX_AGE_MS = 10_000;

// The version of the server that runs. The root of the repository holds it, and the backup manifest has the same number.
export const APP_VERSION: string = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version;

const parts = (version: string) => version.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);

// A version is newer when the first number that differs is greater. A missing number counts as 0.
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parts(candidate);
  const now = parts(current);
  for (let index = 0; index < Math.max(next.length, now.length); index++) {
    const difference = (next[index] ?? 0) - (now[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

// Reads the latest release of the repository. GitHub needs a user agent, and a public repository needs no token.
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<UpdateCheck> {
  const res = await fetchImpl(RELEASE_URL, {
    headers: RELEASE_HEADERS,
    signal: AbortSignal.timeout(MAX_AGE_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered with status ${res.status}.`);
  const release = (await res.json()) as { tag_name?: unknown; html_url?: unknown; body?: unknown };
  if (typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') throw new Error('The release has no tag or url.');
  const latest = release.tag_name.replace(/^v/i, '');
  const notes = typeof release.body === 'string' && release.body.trim() ? release.body.trim() : null;
  return { available: isNewerVersion(latest, APP_VERSION), latest, url: release.html_url, notes };
}
