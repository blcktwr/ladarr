import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type ProbeResult =
  | { ok: true; durationSeconds: number; container: string; videoCodec: string; audioLanguages: string[] }
  // `unreadable`: ffprobe cannot read the file. `no_video`: it has no video stream. `too_short`: it is shorter than a second.
  | { ok: false; reason: 'unreadable' | 'no_video' | 'too_short' }
  // ffprobe is not installed. The check is skipped, and the caller says so.
  | { ok: 'skipped' };

export type SideData = { side_data_type?: string };
export type Stream = {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  display_aspect_ratio?: string;
  avg_frame_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  side_data_list?: SideData[];
  tags?: { language?: string };
};
export type Raw = { format?: { duration?: string; format_name?: string; bit_rate?: string }; streams?: Stream[] };

// Runs ffprobe and returns what it printed. `skipped`: ffprobe is not installed. `unreadable`: ffprobe cannot read the file.
export async function ffprobeRaw(path: string): Promise<{ data: Raw } | { error: 'skipped' | 'unreadable' }> {
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

// Reads the duration, the container, the video codec, and the audio languages with ffprobe.
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
