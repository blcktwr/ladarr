import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { infoHashOf, magnetHash, torrentComment, torrentInfo } from '../../src/library/grab/torrent.ts';

describe('infoHashOf', () => {
  const info = Buffer.from('d6:lengthi1000e4:name4:file12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe');
  const torrent = Buffer.concat([Buffer.from('d8:announce20:http://tracker/a?x=y4:infoX'.replace('X', '')), info, Buffer.from('7:comment2:hie')]);

  it('hashes the info dictionary as it is in the file', () => {
    expect(infoHashOf(torrent)).toBe(createHash('sha1').update(info).digest('hex'));
  });

  it('handles an info dictionary that comes first', () => {
    expect(infoHashOf(Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]))).toBe(createHash('sha1').update(info).digest('hex'));
  });

  it('rejects data that is not a torrent', () => {
    for (const bad of ['', 'not a torrent', 'd8:announce3:abce', 'd4:infoi1ee', 'd4:info', 'd4:infod4:name99:shorte', `${'l'.repeat(100)}`]) {
      expect(() => infoHashOf(Buffer.from(bad))).toThrow('invalid torrent');
    }
  });
});

describe('torrentComment', () => {
  const info = Buffer.from('d6:lengthi1000e4:name4:file12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe');
  // A torrent whose top-level dictionary ends with the given key and value.
  const torrent = (extra = '') => Buffer.concat([Buffer.from('d8:announce20:http://tracker/a?x=y4:info'), info, Buffer.from(`${extra}e`)]);

  it('returns the comment of the torrent', () => {
    expect(torrentComment(torrent('7:comment2:hi'))).toBe('hi');
  });

  it('returns nothing when the torrent has no comment', () => {
    expect(torrentComment(torrent())).toBeUndefined();
  });

  it('returns nothing when the comment is not a string', () => {
    expect(torrentComment(torrent('7:commenti42e'))).toBeUndefined();
  });

  it('returns nothing when the comment is empty', () => {
    expect(torrentComment(torrent('7:comment0:'))).toBeUndefined();
  });

  it('rejects data that is not a torrent', () => {
    for (const bad of ['', 'not a torrent', 'd8:announce3:abc', 'd4:info', 'i42e', 'd7:comment2:hi']) {
      expect(() => torrentComment(Buffer.from(bad))).toThrow('invalid torrent');
    }
  });
});

describe('torrentInfo', () => {
  // A torrent whose top-level dictionary holds the fields that its writer added.
  const torrent = (info: string, extra = '') => Buffer.from(`d8:announce20:http://tracker/a?x=y4:info${info}${extra}e`);
  const single = 'd6:lengthi1000e4:name4:file12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe';
  // Two files, one of them in a folder. The path of each file starts with the name of the torrent.
  const multiple = 'd5:filesld6:lengthi1000e4:pathl5:a.mkveed6:lengthi2000e4:pathl1:d5:b.mkveee4:name4:show12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe';
  const extra = '10:created by4:tool13:creation datei1700000000e7:comment2:hi';

  it('gives the name, the files, and their total size', () => {
    expect(torrentInfo(torrent(multiple))).toEqual({
      name: 'show',
      hash: createHash('sha1').update(multiple).digest('hex'),
      files: [
        { path: 'show/a.mkv', sizeBytes: 1000 },
        { path: 'show/d/b.mkv', sizeBytes: 2000 },
      ],
      totalBytes: 3000,
      comment: null,
      source: null,
      createdBy: null,
      createdAt: null,
      pieceLength: 16384,
      pieceCount: 1,
      private: false,
    });
  });

  it('gives the one file of a torrent that has no file list', () => {
    expect(torrentInfo(torrent(single)).files).toEqual([{ path: 'file', sizeBytes: 1000 }]);
  });

  it('gives the fields that the writer added, with the date in milliseconds', () => {
    expect(torrentInfo(torrent(multiple, extra))).toMatchObject({ comment: 'hi', createdBy: 'tool', createdAt: 1700000000000 });
  });

  it('gives the privacy and the source', () => {
    const info = 'd6:lengthi1000e4:name4:file12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAA7:privatei1e6:source4:teame';
    const top = `d8:announce20:http://tracker/a?x=y4:info${info}e`;
    expect(torrentInfo(Buffer.from(top))).toMatchObject({ private: true, source: 'team' });
  });

  it('rejects data that is not a torrent', () => {
    for (const bad of ['', 'd8:announce3:abce', 'd4:infoi1ee', 'd4:infod6:lengthi1eee']) {
      expect(() => torrentInfo(Buffer.from(bad))).toThrow('invalid torrent');
    }
  });
});

describe('magnetHash', () => {
  it('reads hex and base32 hashes', () => {
    expect(magnetHash('magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=x')).toBe('abcdef0123456789abcdef0123456789abcdef01');
    // 20 bytes of 0x00 to 0x13 in base32.
    const bytes = Buffer.from(Array.from({ length: 20 }, (_, i) => i));
    const base32 = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('').match(/.{5}/g)!.map((bits) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(bits, 2)]).join('');
    expect(magnetHash(`magnet:?xt=urn:btih:${base32}`)).toBe(bytes.toString('hex'));
  });

  it('returns nothing for other links', () => {
    expect(magnetHash('http://example.com/a.torrent')).toBeUndefined();
    expect(magnetHash('magnet:?dn=x')).toBeUndefined();
    expect(magnetHash('magnet:?xt=urn:btih:short')).toBeUndefined();
    expect(magnetHash('not a url')).toBeUndefined();
  });
});
