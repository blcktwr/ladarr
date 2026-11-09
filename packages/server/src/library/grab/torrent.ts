import { createHash } from 'node:crypto';

const MAX_DEPTH = 16;
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
function decode(buf: Buffer, at: number, depth = 0): { value: unknown; end: number } {
  const end = skip(buf, at, depth);
  const byte = buf[at]!;
  if (byte === 0x69) return { value: Number(buf.toString('latin1', at + 1, end - 1)), end };
  if (byte === 0x6c) {
    const list: unknown[] = [];
    for (let next = at + 1; next < end - 1; ) {
      const item = decode(buf, next, depth + 1);
      if (list.push(item.value) > MAX_TORRENT_FILES) throw new Error('invalid torrent');
      next = item.end;
    }
    return { value: list, end };
  }
  if (byte === 0x64) {
    const dict: Record<string, unknown> = Object.create(null);
    for (let next = at + 1; next < end - 1; ) {
      const key = decode(buf, next, depth + 1);
      const item = decode(buf, key.end, depth + 1);
      dict[String(key.value)] = item.value;
      next = item.end;
    }
    return { value: dict, end };
  }
  const colon = buf.indexOf(0x3a, at);
  return { value: buf.toString('utf8', colon + 1, end), end };
}

// The files of a torrent, with the path inside the download. A torrent with one file gives that file.
export function torrentFiles(torrent: Buffer): { path: string; length: number }[] {
  const top = decode(torrent, 0).value as { info?: { name?: unknown; length?: unknown; files?: unknown } };
  const info = top.info;
  if (!info || typeof info.name !== 'string') throw new Error('invalid torrent');
  if (!Array.isArray(info.files)) return [{ path: info.name, length: Number(info.length) || 0 }];
  return info.files.map((file: { path?: unknown; length?: unknown }) => {
    if (!Array.isArray(file?.path) || !file.path.every((part) => typeof part === 'string')) throw new Error('invalid torrent');
    return { path: [info.name, ...file.path].join('/'), length: Number(file.length) || 0 };
  });
}
