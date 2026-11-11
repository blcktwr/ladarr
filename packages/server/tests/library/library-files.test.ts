import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { open, type Db } from '../../src/core/db.ts';
import { describeProbe, libraryFilesRouter } from '../../src/library/tools/files.ts';
import type { ffprobeRaw } from '../../src/library/probe.ts';
import { scanTitle } from '../../src/library/scan.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { episode, title } from '../helpers/test-fixtures.ts';

let dir: string;
let root: string;
let db: Db;
let app: Awaited<ReturnType<typeof startTestApp>>;

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Serves the router without the sign-in, with a probe that the test controls.
async function serve(probe: typeof ffprobeRaw) {
  const server = express().use('/library', libraryFilesRouter({ probe })).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/library`;
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  return { get, close: () => void (server.closeAllConnections(), server.close()) };
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-files-')));
  root = join(dir, 'tv');
  mkdirSync(join(root, 'Show', 'Season 01'), { recursive: true });
  writeFileSync(join(root, 'Show', 'Season 01', 'Show.S01E01.mkv'), 'not a video');
  writeFileSync(join(root, 'Show', 'Season 01', 'Show.S01E02.mkv'), 'not a video either');
  db = await open('unused.json');
  db.data.roots = { tv: { id: 'tv', path: root, mediaType: 'tv', dev: statSync(root).dev } };
  db.data.titles['tv:1'] = title({ rootId: 'tv', folder: 'Show', episodes: [episode(1, 1), episode(1, 2)] });
  await scanTitle('tv:1');
  app = await startTestApp({}, db);
});
afterAll(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

const fileOf = (n: number) => db.data.titles['tv:1']!.episodes[n - 1]!.fileId!;

describe('file list', () => {
  it('lists the records of a title without reading the disk, and filters by episode', async () => {
    const all = await app.get('/library/tv:1/files');
    expect(all.body.files.map((file: { path: string }) => file.path)).toEqual(['Show/Season 01/Show.S01E01.mkv', 'Show/Season 01/Show.S01E02.mkv']);
    const one = await app.get('/library/tv:1/files?season=1&number=2');
    expect(one.body.files).toMatchObject([{ path: 'Show/Season 01/Show.S01E02.mkv', episodes: [{ season: 1, number: 2 }], missing: false }]);
    expect((await app.get('/library/tv:1/files?season=1&number=9')).body.files).toEqual([]);
  });

  it.each(['?season=1', '?number=1', '?season=x&number=1'])('rejects the query %s', async (query) => {
    expect((await app.get(`/library/tv:1/files${query}`)).body).toEqual({ error: 'invalid_episode' });
  });

  it('answers 404 for a title or a file that does not exist, or that belongs to another title', async () => {
    expect((await app.get('/library/tv:99/files')).status).toBe(404);
    expect((await app.get('/library/tv:1/files/nope')).status).toBe(404);
    db.data.files.other = { id: 'other', titleKey: 'movie:2', path: 'x.mkv', sizeBytes: 1, mtimeMs: 1, episodes: [], missing: false, addedAt: 0 };
    expect((await app.get('/library/tv:1/files/other')).status).toBe(404);
  });

  it('does not take the place of the other library routes', async () => {
    expect((await app.get('/library/tv:1')).status).toBe(200);
    expect((await app.get('/library/folders')).body).toHaveProperty('folders');
  });
});

describe('file details', () => {
  it('reads the file with ffprobe only when asked, and maps the answer', async () => {
    const calls: string[] = [];
    const server = await serve(async (path) => {
      calls.push(path);
      return { data: { format: { format_name: 'matroska,webm', duration: '3600.5', bit_rate: '8000000' }, streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, avg_frame_rate: '24000/1001' }, { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'eng' } }] } };
    });
    try {
      expect(calls).toEqual([]);
      const { body } = await server.get(`/tv:1/files/${fileOf(1)}`);
      expect(calls).toEqual([join(root, 'Show', 'Season 01', 'Show.S01E01.mkv')]);
      expect(body.details).toEqual({ state: 'ok', container: 'matroska,webm', durationSeconds: 3600.5, bitrate: 8000000, video: { codec: 'hevc', width: 1920, height: 1080, frameRate: 23.976 }, audio: [{ codec: 'eac3', channels: 6, language: 'eng' }], subtitles: [] });
      expect(body.file.path).toBe('Show/Season 01/Show.S01E01.mkv');
    } finally {
      server.close();
    }
  });

  it('reports ffprobe that is not installed and a file that ffprobe cannot read', async () => {
    const skipped = await serve(async () => ({ error: 'skipped' }));
    const unreadable = await serve(async () => ({ error: 'unreadable' }));
    try {
      expect((await skipped.get(`/tv:1/files/${fileOf(1)}`)).body.details).toEqual({ state: 'ffprobe_missing' });
      expect((await unreadable.get(`/tv:1/files/${fileOf(1)}`)).body.details).toEqual({ state: 'unreadable' });
    } finally {
      skipped.close();
      unreadable.close();
    }
  });

  it('says missing for a file that is gone, and root_unavailable for a root that changed, without calling ffprobe', async () => {
    const calls: string[] = [];
    const server = await serve(async (path) => {
      calls.push(path);
      return { error: 'unreadable' };
    });
    try {
      rmSync(join(root, 'Show', 'Season 01', 'Show.S01E02.mkv'));
      expect((await server.get(`/tv:1/files/${fileOf(2)}`)).body.details).toEqual({ state: 'missing' });
      db.data.roots.tv!.dev += 1;
      expect((await server.get(`/tv:1/files/${fileOf(1)}`)).body.details).toEqual({ state: 'root_unavailable' });
      db.data.roots.tv!.dev -= 1;
      expect(calls).toEqual([]);
    } finally {
      server.close();
      writeFileSync(join(root, 'Show', 'Season 01', 'Show.S01E02.mkv'), 'not a video either');
    }
  });

  it('does not read a file behind a link that leaves the root', async () => {
    const calls: string[] = [];
    const server = await serve(async (path) => {
      calls.push(path);
      return { error: 'unreadable' };
    });
    try {
      writeFileSync(join(dir, 'secret.mkv'), 'x');
      symlinkSync(dir, join(root, 'Show', 'Season 02'));
      db.data.files.escape = { id: 'escape', titleKey: 'tv:1', path: 'Show/Season 02/secret.mkv', sizeBytes: 1, mtimeMs: 1, episodes: [], missing: false, addedAt: 0 };
      expect((await server.get('/tv:1/files/escape')).body.details).toEqual({ state: 'unreadable' });
      expect(calls).toEqual([]);
    } finally {
      server.close();
      delete db.data.files.escape;
    }
  });

  it('does not read a file that is a link to a file outside the root, and reads a link that stays inside', async () => {
    const calls: string[] = [];
    const server = await serve(async (path) => {
      calls.push(path);
      return { error: 'unreadable' };
    });
    try {
      writeFileSync(join(dir, 'outside.mkv'), 'x');
      symlinkSync(join(dir, 'outside.mkv'), join(root, 'Show', 'Season 01', 'out-link.mkv'));
      symlinkSync(join(root, 'Show', 'Season 01', 'Show.S01E01.mkv'), join(root, 'Show', 'Season 01', 'in-link.mkv'));
      for (const name of ['out-link', 'in-link']) {
        db.data.files[name] = { id: name, titleKey: 'tv:1', path: `Show/Season 01/${name}.mkv`, sizeBytes: 1, mtimeMs: 1, episodes: [], missing: false, addedAt: 0 };
      }
      expect((await server.get('/tv:1/files/out-link')).body.details).toEqual({ state: 'unreadable' });
      expect(calls).toEqual([]);
      await server.get('/tv:1/files/in-link');
      expect(calls).toEqual([join(root, 'Show', 'Season 01', 'in-link.mkv')]);
    } finally {
      server.close();
      delete db.data.files['out-link'];
      delete db.data.files['in-link'];
    }
  });

  it('limits the reads that run at the same time', async () => {
    const release: (() => void)[] = [];
    const server = await serve(() => new Promise((resolve) => release.push(() => resolve({ error: 'unreadable' }))));
    try {
      const path = `/tv:1/files/${fileOf(1)}`;
      const pending = [0, 1, 2].map(() => server.get(path));
      await vi.waitFor(() => expect(release).toHaveLength(3));
      expect((await server.get(path)).status).toBe(429);
      release.forEach((done) => done());
      expect((await Promise.all(pending)).map((answer) => answer.status)).toEqual([200, 200, 200]);
      // The slots are free again.
      const next = server.get(path);
      await vi.waitFor(() => expect(release).toHaveLength(4));
      release[3]!();
      expect((await next).status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('describeProbe', () => {
  it('ignores cover art, keeps the order of the streams, and uses null for what ffprobe does not tell', () => {
    expect(
      describeProbe({
        format: { format_name: 'mov,mp4' },
        streams: [
          { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
          { codec_type: 'video', codec_name: 'h264', avg_frame_rate: '0/0' },
          { codec_type: 'audio', codec_name: 'aac' },
          { codec_type: 'audio', codec_name: 'ac3', channels: 2, tags: { language: 'spa' } },
          { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'fra' } },
        ],
      }),
    ).toEqual({
      state: 'ok',
      container: 'mov,mp4',
      durationSeconds: null,
      bitrate: null,
      video: { codec: 'h264', width: null, height: null, frameRate: null },
      audio: [{ codec: 'aac', channels: null, language: 'und' }, { codec: 'ac3', channels: 2, language: 'spa' }],
      subtitles: [{ codec: 'subrip', language: 'fra' }],
    });
  });

  it('reports a file without a video stream', () => {
    expect(describeProbe({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] })).toEqual({ state: 'no_video' });
  });
});

describe.skipIf(!hasFfmpeg)('with the real ffprobe', () => {
  it('reads a file that ffmpeg made, and calls a text file unreadable', async () => {
    const movie = join(root, 'Real', 'Real.S01E01.mkv');
    mkdirSync(join(root, 'Real'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-metadata:s:a:0', 'language=eng', '-shortest', movie]);
    writeFileSync(join(root, 'Real', 'Real.S01E02.mkv'), 'plain text');
    db.data.titles['tv:7'] = title({ key: 'tv:7', tmdbId: 7, rootId: 'tv', folder: 'Real', episodes: [episode(1, 1), episode(1, 2)] });
    await scanTitle('tv:7');
    const good = await app.get(`/library/tv:7/files/${db.data.titles['tv:7']!.episodes[0]!.fileId}`);
    expect(good.body.details).toMatchObject({ state: 'ok', video: { codec: 'mpeg4', width: 64, height: 48, frameRate: 10 }, audio: [{ codec: 'aac', language: 'eng' }], subtitles: [] });
    expect(good.body.details.durationSeconds).toBeGreaterThan(0.9);
    const bad = await app.get(`/library/tv:7/files/${db.data.titles['tv:7']!.episodes[1]!.fileId}`);
    expect(bad.body.details).toEqual({ state: 'unreadable' });
  });
});
