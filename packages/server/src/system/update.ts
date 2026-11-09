import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { APP_VERSION, isNewerVersion, RELEASE_HEADERS, RELEASE_URL } from './version.ts';

const run = promisify(execFile);
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
// The folder of the process: packages/server/src/system/update.ts is four levels down.
const APP_DIR = fileURLToPath(new URL('../../../../', import.meta.url));

export type ReleaseAsset = { name: string; url: string };
export type ReleaseInfo = { version: string; url: string; assets: ReleaseAsset[] };
export type UpdateErrorCode = 'no_update' | 'asset_missing' | 'download_failed' | 'checksum_mismatch' | 'extract_failed';

export class UpdateError extends Error {
  code: UpdateErrorCode;

  constructor(code: UpdateErrorCode, message: string = code) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

// Reads the newest release, with the files that it holds.
export async function latestRelease(fetchImpl: typeof fetch = fetch): Promise<ReleaseInfo> {
  const res = await fetchImpl(RELEASE_URL, { headers: RELEASE_HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new UpdateError('download_failed', `GitHub answered with status ${res.status}.`);
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; assets?: unknown };
  if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') throw new UpdateError('download_failed', 'The release has no tag or url.');
  const assets = Array.isArray(body.assets)
    ? body.assets.flatMap((asset: unknown) => {
        const row = asset as { name?: unknown; browser_download_url?: unknown };
        return typeof row.name === 'string' && typeof row.browser_download_url === 'string'
          ? [{ name: row.name, url: row.browser_download_url }]
          : [];
      })
    : [];
  return { version: body.tag_name.replace(/^v/i, ''), url: body.html_url, assets };
}

// Downloads the bundle of the newest release into appDir and replaces the files of the process.
// The caller restarts the process after this call returns.
export type InstallOptions = { appDir?: string; fetchImpl?: typeof fetch; currentVersion?: string };

export async function installUpdate({ appDir = APP_DIR, fetchImpl = fetch, currentVersion = APP_VERSION }: InstallOptions = {}): Promise<{ version: string }> {
  const release = await latestRelease(fetchImpl);
  if (!isNewerVersion(release.version, currentVersion)) throw new UpdateError('no_update', `Version ${currentVersion} is not older than ${release.version}.`);
  const bundleName = `ladarr-${release.version}.tar.gz`;
  const bundle = release.assets.find((asset) => asset.name === bundleName);
  const checksum = release.assets.find((asset) => asset.name === `${bundleName}.sha256`);
  if (!bundle) throw new UpdateError('asset_missing', `The release has no ${bundleName}.`);
  if (!checksum) throw new UpdateError('asset_missing', `The release has no ${bundleName}.sha256.`);

  const staging = join(appDir, `.update-${release.version}`);
  const extracted = join(staging, 'app');
  await mkdir(extracted, { recursive: true });
  try {
    const file = join(staging, bundleName);
    await download(fetchImpl, bundle.url, file);
    await verify(fetchImpl, checksum.url, file);
    await extract(file, extracted);
    await replace(appDir, extracted, join(staging, 'old'));
    return { version: release.version };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function download(fetchImpl: typeof fetch, url: string, file: string) {
  try {
    const res = await fetchImpl(url, { headers: RELEASE_HEADERS, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`The download answered with status ${res.status}.`);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file));
  } catch (error) {
    throw new UpdateError('download_failed', `The bundle did not download: ${(error as Error).message}`);
  }
}

// The file of checksums has the value first, then the name of the file.
async function verify(fetchImpl: typeof fetch, url: string, file: string) {
  const res = await fetchImpl(url, { headers: RELEASE_HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new UpdateError('download_failed', `The checksum answered with status ${res.status}.`);
  const expected = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const actual = createHash('sha256').update(await readFile(file)).digest('hex');
  if (!expected || expected !== actual) throw new UpdateError('checksum_mismatch', `The bundle has the hash ${actual} and the release says ${expected}.`);
}

async function extract(file: string, dir: string) {
  try {
    await run('tar', ['-xzf', file, '-C', dir]);
  } catch (error) {
    throw new UpdateError('extract_failed', `The bundle did not extract: ${(error as Error).message}`);
  }
  if ((await readdir(dir)).length === 0) throw new UpdateError('extract_failed', 'The bundle has no files.');
}

// Each entry of the bundle replaces the entry of the same name. A file of the old version that the bundle
// does not have goes away with its folder. A failure puts the old entries back.
async function replace(appDir: string, extracted: string, backup: string) {
  const entries = await readdir(extracted);
  const placed: string[] = [];
  const kept: string[] = [];
  await mkdir(backup, { recursive: true });
  try {
    for (const entry of entries) {
      const old = join(appDir, entry);
      try {
        await rename(old, join(backup, entry));
        kept.push(entry);
      } catch {
        // The old version has no entry of this name.
      }
      await rename(join(extracted, entry), old);
      placed.push(entry);
    }
  } catch (error) {
    for (const entry of placed) await rename(join(appDir, entry), join(extracted, entry)).catch(() => {});
    for (const entry of kept) await rename(join(backup, entry), join(appDir, entry)).catch(() => {});
    throw new UpdateError('extract_failed', `The files did not change: ${(error as Error).message}`);
  }
}
