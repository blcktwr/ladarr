import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FormatTags, ProbeRaw, ProbeResult } from '../types.ts';

const run = promisify(execFile);

// Runs ffprobe and returns what it printed. `skipped`: ffprobe is not installed. `unreadable`: ffprobe cannot read the file.
export async function ffprobeRaw(path: string): Promise<{ data: ProbeRaw } | { error: 'skipped' | 'unreadable' }> {
  let stdout: string;
  try {
    ({ stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 }));
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'skipped' : 'unreadable' };
  }
  try {
    return { data: JSON.parse(stdout) };
  } catch {
    return { error: 'unreadable' };
  }
}

// The tag keys of a file do not have one letter case, so the reader compares them in upper case.
export function formatTags(raw: ProbeRaw['format']): FormatTags {
  const tags = new Map(Object.entries(raw?.tags ?? {}).map(([key, value]) => [key.trim().toUpperCase(), value.trim()]));
  const text = (key: string) => tags.get(key) || null;
  const number = (key: string) => {
    const value = tags.get(key);
    if (!value) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  };
  return { title: text('TITLE'), season: number('SEASON_NUMBER'), episode: number('EPISODE_ID') };
}

// Reads the duration, the container, the video codec, the audio languages and the tags that name the content, with
// ffprobe.
export async function probeFile(path: string): Promise<ProbeResult> {
  const raw = await ffprobeRaw(path);
  if ('error' in raw) return raw.error === 'skipped' ? { ok: 'skipped' } : { ok: false, reason: 'unreadable' };
  const data = raw.data;
  const streams = data.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) return { ok: false, reason: 'no_video' };
  const durationSeconds = Number(data.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1) return { ok: false, reason: 'too_short' };
  return {
    ok: true,
    durationSeconds,
    container: data.format?.format_name ?? 'unknown',
    videoCodec: video.codec_name ?? 'unknown',
    audioLanguages: streams.filter((stream) => stream.codec_type === 'audio').map((stream) => stream.tags?.language ?? 'und'),
    tags: formatTags(data.format),
  };
}

let available: Promise<boolean> | undefined;

// True when ffprobe runs. The answer is kept, because ffprobe does not appear while ladarr runs.
export function ffprobeAvailable() {
  return (available ??= run('ffprobe', ['-version'], { timeout: 10_000 }).then(
    () => true,
    () => false,
  ));
}
