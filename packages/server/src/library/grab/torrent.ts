import { createHash } from 'node:crypto';
import type { QueueTorrent } from '@ladarr/shared/types';
import { parseRelease } from './release.ts';
import { sourceLabel } from './quality.ts';
import { isVideoFile } from '../parse.ts';

const MAX_DEPTH = 16;
export const MAX_TORRENT_BYTES = 5 * 1024 * 1024;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Finds where a bencoded value ends. A torrent file comes from outside, so every length is checked.
function skip(buf: Buffer, at: number, depth = 0): number {
  if (depth > MAX_DEPTH || at >= buf.length) throw new Error('invalid torrent');
  const byte = buf[at]!;
  if (byte === 0x69) {
    // Integer: i<digits>e
    const end = buf.indexOf(0x65, at);
    if (end < 0 || !/^-?\d+$/.test(buf.toString('latin1', at + 1, end))) throw new Error('invalid torrent');
    return end + 1;
  }
  if (byte === 0x6c || byte === 0x64) {
    let next = at + 1;
    while (buf[next] !== 0x65) {
      if (next >= buf.length) throw new Error('invalid torrent');
      next = skip(buf, next, depth + 1);
    }
    return next + 1;
  }
  const colon = buf.indexOf(0x3a, at);
  const length = colon < 0 ? NaN : Number(buf.toString('latin1', at, colon));
  if (!Number.isInteger(length) || length < 0 || colon + 1 + length > buf.length) throw new Error('invalid torrent');
  return colon + 1 + length;
}

// The info hash is the SHA-1 of the "info" dictionary exactly as it is in the file.
export function infoHashOf(torrent: Buffer): string {
  if (torrent[0] !== 0x64) throw new Error('invalid torrent');
  let at = 1;
  while (torrent[at] !== 0x65) {
    const keyEnd = skip(torrent, at);
    const colon = torrent.indexOf(0x3a, at);
    const key = torrent.toString('latin1', colon + 1, keyEnd);
    const valueEnd = skip(torrent, keyEnd);
    if (key === 'info') {
      if (torrent[keyEnd] !== 0x64) throw new Error('invalid torrent');
      return createHash('sha1').update(torrent.subarray(keyEnd, valueEnd)).digest('hex');
    }
    at = valueEnd;
  }
  throw new Error('invalid torrent');
}

// Reads the info hash of a magnet link: 40 hex digits, or 32 characters in base32. Returns nothing for any other link.
export function magnetHash(magnet: string): string | undefined {
  let value: string | null;
  try {
    value = new URL(magnet).searchParams.getAll('xt').find((xt) => xt.toLowerCase().startsWith('urn:btih:'))?.slice(9) ?? null;
  } catch {
    return;
  }
  if (!value) return;
  if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (!/^[A-Z2-7]{32}$/i.test(value)) return;
  let bits = '';
  for (const char of value.toUpperCase()) bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  return bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2).toString(16).padStart(2, '0')).join('');
}

const MAX_TORRENT_FILES = 20_000;

// Reads a bencoded value. A torrent file comes from outside, so every length is checked.
function decode(buf: Buffer, at: number, depth = 0, strict = false): { value: unknown; end: number } {
  const end = skip(buf, at, depth);
  const byte = buf[at]!;
  if (byte === 0x69) {
    const number = buf.toString('latin1', at + 1, end - 1);
    if (strict && !/^(?:0|-?[1-9]\d*)$/.test(number)) throw new Error('invalid torrent');
    return { value: Number(number), end };
  }
  if (byte === 0x6c) {
    const list: unknown[] = [];
    for (let next = at + 1; next < end - 1; ) {
      const item = decode(buf, next, depth + 1, strict);
      if (list.push(item.value) > MAX_TORRENT_FILES) throw new Error('invalid torrent');
      next = item.end;
    }
    return { value: list, end };
  }
  if (byte === 0x64) {
    const dict: Record<string, unknown> = Object.create(null);
    for (let next = at + 1; next < end - 1; ) {
      const key = decode(buf, next, depth + 1, strict);
      if (strict && (typeof key.value !== 'string' || Object.hasOwn(dict, key.value))) throw new Error('invalid torrent');
      const item = decode(buf, key.end, depth + 1, strict);
      if (strict && depth === 1 && key.value === 'pieces' && typeof item.value === 'string') {
        item.value = buf.subarray(buf.indexOf(0x3a, key.end) + 1, item.end);
      }
      dict[String(key.value)] = item.value;
      next = item.end;
    }
    return { value: dict, end };
  }
  const colon = buf.indexOf(0x3a, at);
  if (strict && !/^(?:0|[1-9]\d*)$/.test(buf.toString('latin1', at, colon))) throw new Error('invalid torrent');
  return { value: buf.toString('utf8', colon + 1, end), end };
}

// The comment of a torrent. It is a top-level key, and it is absent in most torrents.
export function torrentComment(torrent: Buffer): string | undefined {
  if (torrent[0] !== 0x64) throw new Error('invalid torrent');
  const top = decode(torrent, 0).value as { comment?: unknown };
  return typeof top.comment === 'string' && top.comment.length > 0 ? top.comment : undefined;
}

// The files of a torrent, with the path inside the download. A torrent with one file gives that file.
export function torrentFiles(torrent: Buffer): { path: string; length: number }[] {
  const top = decode(torrent, 0).value as { info?: { name?: unknown; length?: unknown; files?: unknown } };
  return manifest(top);
}

type FileInfo = { name?: unknown; 'name.utf-8'?: unknown; length?: unknown; files?: unknown; attr?: unknown; 'piece length'?: unknown; pieces?: unknown; private?: unknown; source?: unknown };
const safePart = (part: unknown): part is string => typeof part === 'string' && !!part.trim() && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255 && !/[\\/\x00-\x1f]/.test(part) && !/^[a-z]:/i.test(part);
const validLength = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const symlink = (attr: unknown) => typeof attr === 'string' && attr.includes('l');

function manifest(top: { info?: FileInfo }, strict = false): { path: string; length: number }[] {
  const info = top.info;
  if (!info || typeof info.name !== 'string') throw new Error('invalid torrent');
  if (strict && (!safePart(info.name) || (info['name.utf-8'] !== undefined && !safePart(info['name.utf-8'])) || symlink(info.attr)
    || (info.files !== undefined ? !Array.isArray(info.files) || info.length !== undefined : !validLength(info.length)))) throw new Error('invalid torrent');
  const name = strict && typeof info['name.utf-8'] === 'string' ? info['name.utf-8'] : info.name;
  if (!Array.isArray(info.files)) return [{ path: name, length: Number(info.length) || 0 }];
  const paths = new Set<string>();
  const directories = new Set<string>();
  return info.files.map((file: { path?: unknown; 'path.utf-8'?: unknown; length?: unknown; attr?: unknown }) => {
    if (!Array.isArray(file?.path) || !file.path.every((part) => typeof part === 'string')) throw new Error('invalid torrent');
    const utf8 = file['path.utf-8'];
    const components = strict && Array.isArray(utf8) ? utf8 : file.path;
    const path = [name, ...components].join('/');
    if (strict) {
      if (!file.path.length || !file.path.every(safePart) || (utf8 !== undefined && (!Array.isArray(utf8) || !utf8.length || !utf8.every(safePart)))
        || !validLength(file.length) || Buffer.byteLength(path) > 4_096 || paths.has(path) || directories.has(path) || symlink(file.attr)) throw new Error('invalid torrent');
      let dir = name;
      for (const component of components.slice(0, -1)) {
        dir += `/${component}`;
        if (paths.has(dir)) throw new Error('invalid torrent');
        directories.add(dir);
      }
      paths.add(path);
    }
    return { path, length: Number(file.length) || 0 };
  });
}

const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

// What a torrent says about itself, as the tools of the protocol show it.
export function torrentInfo(torrent: Buffer, strict = false): QueueTorrent {
  const decoded = decode(torrent, 0, 0, strict);
  if (strict && (decoded.end !== torrent.length || torrent[0] !== 0x64)) throw new Error('invalid torrent');
  const top = decoded.value as {
    comment?: unknown;
    'created by'?: unknown;
    'creation date'?: unknown;
    info?: FileInfo;
  };
  const info = top.info;
  if (!info || typeof info.name !== 'string') throw new Error('invalid torrent');
  const files = manifest(top, strict).map((file) => ({ path: file.path, sizeBytes: file.length }));
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const pieceLength = typeof info['piece length'] === 'number' && info['piece length'] > 0 ? info['piece length'] : null;
  if (strict && (!Number.isSafeInteger(totalBytes) || totalBytes === 0 || !pieceLength || !Number.isSafeInteger(pieceLength) || !Buffer.isBuffer(info.pieces) || info.pieces.length !== 20 * Math.ceil(totalBytes / pieceLength))) throw new Error('invalid torrent');
  // The name of the torrent is a release name in most files. A name that gives only the title and the resolution, as
  // most torrents of a tracker do, leaves the source to the name of its largest video file, which is the feature.
  const name = strict && typeof info['name.utf-8'] === 'string' ? info['name.utf-8'] : info.name;
  const named = parseRelease(name);
  const largest = files
    .filter((file) => isVideoFile(file.path))
    .reduce<(typeof files)[number] | null>((best, file) => (!best || file.sizeBytes > best.sizeBytes ? file : best), null);
  const feature = largest ? parseRelease(largest.path.split('/').at(-1) ?? '') : null;
  const resolution = feature?.resolution ?? named.resolution ?? null;
  const source = feature && feature.source !== 'unknown' ? feature.source : named.source;
  return {
    name,
    hash: infoHashOf(torrent),
    files,
    totalBytes,
    resolution,
    quality: source === 'unknown' ? null : sourceLabel(source),
    comment: text(top.comment),
    source: text(info.source),
    createdBy: text(top['created by']),
    createdAt: typeof top['creation date'] === 'number' ? top['creation date'] * 1000 : null,
    pieceLength,
    pieceCount: pieceLength ? Math.ceil(totalBytes / pieceLength) : null,
    private: info.private === 1,
  };
}
