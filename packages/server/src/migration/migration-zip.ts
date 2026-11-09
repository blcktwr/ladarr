import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';

// A small reader for ZIP files that come from the user. It never writes a file under a name from the archive.
// shortcut: no ZIP64, no encryption, no split archives. A backup of Sonarr or Radarr uses none of them, so add them only if a real backup does.

export type ZipLimits = {
  // The most entries that the central directory can list.
  entries: number;
  // The most bytes that one entry can have after it is unpacked.
  entryBytes: number;
  // The most that an entry can grow, as a ratio of its packed size.
  ratio: number;
};

export type ZipEntry = { name: string; method: 0 | 8; crc: number; packedSize: number; size: number; offset: number; symlink: boolean };

export class ZipError extends Error {
  code: 'invalid' | 'unsupported' | 'unsafe' | 'too_large';
  constructor(code: ZipError['code']) {
    super(`zip_${code}`);
    this.code = code;
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
const MAX_DIRECTORY_BYTES = 1024 * 1024;
const UNSET_16 = 0xffff;
const UNSET_32 = 0xffffffff;

// A name is safe when it stays inside the folder that the archive opens in.
function safeName(name: string) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').includes('..');
}

export async function listZip(path: string, limits: ZipLimits): Promise<ZipEntry[]> {
  const file = await open(path, 'r');
  try {
    const { size: fileSize } = await file.stat();
    if (fileSize < 22) throw new ZipError('invalid');

    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead !== length) throw new ZipError('invalid');
      return buffer;
    };

    // The end record is the last 22 bytes, or it is before a comment of at most 65535 bytes.
    const tailStart = Math.max(0, fileSize - 22 - MAX_COMMENT);
    const tail = await read(tailStart, fileSize - tailStart);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === EOCD && at + 22 + tail.readUInt16LE(at + 20) === tail.length) {
        end = at;
        break;
      }
    }
    if (end < 0) throw new ZipError('invalid');

    const disk = tail.readUInt16LE(end + 4);
    const directoryDisk = tail.readUInt16LE(end + 6);
    const onDisk = tail.readUInt16LE(end + 8);
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) throw new ZipError('unsupported');
    if (count === UNSET_16 || directorySize === UNSET_32 || directoryOffset === UNSET_32) throw new ZipError('unsupported');
    if (count > limits.entries || directorySize > MAX_DIRECTORY_BYTES) throw new ZipError('too_large');
    if (directoryOffset + directorySize > tailStart + end) throw new ZipError('invalid');

    const directory = await read(directoryOffset, directorySize);
    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let at = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) throw new ZipError('invalid');
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      const packedSize = directory.readUInt32LE(at + 20);
      const size = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const attributes = directory.readUInt32LE(at + 38);
      const offset = directory.readUInt32LE(at + 42);
      const next = at + 46 + nameLength + extraLength + commentLength;
      if (next > directory.length) throw new ZipError('invalid');

      const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
      at = next;
      if (!safeName(name)) throw new ZipError('unsafe');
      // Two entries with one name could show one file to a scanner and another to a reader.
      if (seen.has(name.toLowerCase())) throw new ZipError('unsafe');
      seen.add(name.toLowerCase());

      // A bit 0 is encryption. A bit 6 is strong encryption.
      if (flags & 0x41) throw new ZipError('unsupported');
      if (method !== 0 && method !== 8) throw new ZipError('unsupported');
      if (packedSize === UNSET_32 || size === UNSET_32 || offset === UNSET_32) throw new ZipError('unsupported');
      entries.push({ name, method, crc, packedSize, size, offset, symlink: ((attributes >>> 16) & 0o170000) === 0o120000 });
    }
    if (at !== directory.length) throw new ZipError('invalid');
    return entries;
  } finally {
    await file.close();
  }
}

// Unpacks one entry into a file that the caller names. It stops when the entry grows past its limit.
export async function extractEntry(path: string, entry: ZipEntry, destination: string, limits: ZipLimits) {
  if (entry.symlink || entry.name.endsWith('/')) throw new ZipError('unsafe');
  if (entry.size > limits.entryBytes) throw new ZipError('too_large');
  if (entry.packedSize === 0) throw new ZipError('invalid');
  if (entry.method === 0 && entry.packedSize !== entry.size) throw new ZipError('invalid');
  if (entry.size > entry.packedSize * limits.ratio) throw new ZipError('too_large');

  const file = await open(path, 'r');
  let start: number;
  try {
    const { size: fileSize } = await file.stat();
    const header = Buffer.alloc(30);
    const { bytesRead } = await file.read(header, 0, 30, entry.offset);
    if (bytesRead !== 30 || header.readUInt32LE(0) !== LOCAL) throw new ZipError('invalid');
    // The local header must agree with the central directory.
    if (header.readUInt16LE(8) !== entry.method) throw new ZipError('invalid');
    const nameLength = header.readUInt16LE(26);
    const localName = Buffer.alloc(nameLength);
    await file.read(localName, 0, nameLength, entry.offset + 30);
    if (localName.toString('utf8') !== entry.name) throw new ZipError('invalid');
    start = entry.offset + 30 + nameLength + header.readUInt16LE(28);
    if (start + entry.packedSize > fileSize) throw new ZipError('invalid');
  } finally {
    await file.close();
  }

  let total = 0;
  let sum = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      // The sizes in the headers can be false, so the real count decides.
      if (total > entry.size) return done(new ZipError('too_large'));
      sum = crc32(chunk, sum);
      done(null, chunk);
    },
    flush(done) {
      done(total === entry.size && sum === entry.crc ? null : new ZipError('invalid'));
    },
  });

  try {
    await pipeline(createReadStream(path, { start, end: start + entry.packedSize - 1 }), ...(entry.method === 8 ? [createInflateRaw()] : []), guard, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  } catch (err) {
    if (err instanceof ZipError) throw err;
    // zlib errors mean that the packed data is not valid.
    throw new ZipError('invalid');
  }
}
