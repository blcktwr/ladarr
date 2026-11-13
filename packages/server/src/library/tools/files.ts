import { realpath, stat } from 'node:fs/promises';
import type { FileDetails, FileRow } from '@ladarr/shared/types';
import { Router } from 'express';
import { type Db, type MediaFile, db } from '../../core/db.ts';
import { inside } from '../imports/folder-files.ts';
import { seeFile } from './remove.ts';
import type { Title } from '../library.ts';
import { ffprobeRaw, type Raw, type Stream } from '../probe.ts';
import { qualityOfFile } from '../grab/upgrades.ts';

const KEY = /^(movie|tv):[1-9]\d*$/;
// ffprobe can read a big file for a while. A few at the same time are enough for one person.
const MAX_PROBES = 3;

export const fileRow = (file: MediaFile): FileRow => ({ id: file.id, path: file.path, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, missing: file.missing, episodes: file.episodes, resolution: qualityOfFile(file).resolution });

// The file records of each title, sorted by path.
export function filesByTitle() {
  const groups = new Map<string, MediaFile[]>();
  for (const file of Object.values(db.data.files)) {
    const group = groups.get(file.titleKey);
    if (group) group.push(file);
    else groups.set(file.titleKey, [file]);
  }
  for (const files of groups.values()) files.sort((a, b) => a.path.localeCompare(b.path));
  return groups;
}

const finite = (value: unknown) => (value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

// "24000/1001" gives 23.976. ffprobe prints "0/0" when it does not know the rate.
function frameRate(value: string | undefined) {
  const [top, bottom] = (value ?? '').split('/').map(Number);
  return top && bottom ? Math.round((top / bottom) * 1000) / 1000 : null;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

// The ratio that a person reads, such as 16:9. ffprobe gives it, and the size of the picture makes it when it does not.
function aspectRatio(stream: Stream): string | null {
  const shown = stream.display_aspect_ratio;
  if (shown && /^[1-9]\d*:[1-9]\d*$/.test(shown)) return shown;
  const width = finite(stream.width);
  const height = finite(stream.height);
  if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)) return null;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

// Dolby Vision is the codec tag of the video stream, or its own side data in the stream.
const DOLBY_VISION_TAGS = ['dvh1', 'dvhe', 'dav1'];
const dolbyVision = (stream: Stream) =>
  DOLBY_VISION_TAGS.includes((stream.codec_tag_string ?? '').toLowerCase()) || Boolean(stream.side_data_list?.some((item) => item.side_data_type?.startsWith('DOVI')));

export function describeProbe(data: Raw): FileDetails {
  const streams = data.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video) return { state: 'no_video' };
  return {
    state: 'ok',
    container: data.format?.format_name ?? 'unknown',
    durationSeconds: finite(data.format?.duration),
    bitrate: finite(data.format?.bit_rate),
    video: { codec: video.codec_name ?? 'unknown', width: finite(video.width), height: finite(video.height), aspectRatio: aspectRatio(video), frameRate: frameRate(video.avg_frame_rate), dolbyVision: dolbyVision(video) },
    audio: streams.filter((stream) => stream.codec_type === 'audio').map((stream) => ({ codec: stream.codec_name ?? 'unknown', channels: finite(stream.channels), language: stream.tags?.language ?? 'und' })),
    subtitles: streams.filter((stream) => stream.codec_type === 'subtitle').map((stream) => ({ codec: stream.codec_name ?? 'unknown', language: stream.tags?.language ?? 'und' })),
  };
}

type Deps = { probe?: typeof ffprobeRaw };

export function libraryFilesRouter({ probe = ffprobeRaw }: Deps = {}) {
  const router = Router();
  let running = 0;

  router.param('key', (_req, res, next, key) => {
    const title = KEY.test(key) ? db.data.titles[key] : undefined;
    if (!title) return void res.status(404).json({ error: 'not_found' });
    res.locals.title = title;
    next();
  });

  // The records only. Nothing reads the disk. With `season` and `number`, only the files that cover that episode.
  router.get('/:key/files', (req, res) => {
    const title: Title = res.locals.title;
    const season = req.query.season === undefined ? undefined : Number(req.query.season);
    const number = req.query.number === undefined ? undefined : Number(req.query.number);
    if ((season === undefined) !== (number === undefined) || (season !== undefined && (!Number.isInteger(season) || !Number.isInteger(number)))) {
      return void res.status(400).json({ error: 'invalid_episode' });
    }
    const files = (filesByTitle().get(title.key) ?? []).filter((file) => season === undefined || file.episodes.some((e) => e.season === season && e.number === number));
    res.json({ files: files.map(fileRow) });
  });

  // Reads one file with ffprobe, when the user asks for it.
  router.get('/:key/files/:fileId', async (req, res) => {
    const title: Title = res.locals.title;
    const file = db.data.files[req.params.fileId];
    if (!file || file.titleKey !== title.key) return void res.status(404).json({ error: 'not_found' });
    const done = (details: FileDetails) => void res.json({ file: fileRow(file), details });

    const root = db.data.roots[title.rootId];
    const info = root && (await stat(root.path).catch(() => undefined));
    // A missing mount must not look like a missing file.
    if (!root || !info?.isDirectory() || info.dev !== root.dev) return done({ state: 'root_unavailable' });
    const rootReal = await realpath(root.path);
    const found = await seeFile(rootReal, file.path);
    if ('reason' in found) return done({ state: 'unreadable' });
    if (!found.seen) return done({ state: 'missing' });
    // ffprobe follows a link. The scan accepts a link to a file only inside the root, so this read does the same.
    const target = await realpath(found.abs).catch(() => undefined);
    if (!target || !inside(rootReal, target)) return done({ state: 'unreadable' });

    if (running >= MAX_PROBES) return void res.status(429).json({ error: 'busy' });
    running++;
    try {
      const raw = await probe(found.abs);
      done('error' in raw ? { state: raw.error === 'skipped' ? 'ffprobe_missing' : 'unreadable' } : describeProbe(raw.data));
    } finally {
      running--;
    }
  });

  return router;
}
