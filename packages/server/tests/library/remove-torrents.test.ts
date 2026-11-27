import { describe, expect, it } from 'vitest';
import { torrentsForRemoval } from '../../src/library/tools/remove.ts';
import type { QueueEntry } from '../../src/types.ts';

const release = { guid: 'release', indexerId: 1, indexerName: 'Indexer', title: 'Release', sizeBytes: 1, infoHash: 'hash', link: null, magnet: null, kind: 'single' as const, seeders: 1, manual: false };

const entry = (id: string, change: Partial<QueueEntry> = {}): QueueEntry => ({
  id,
  titleKey: id.startsWith('movie:') ? id : 'tv:1',
  season: null,
  number: null,
  state: { kind: 'downloading' },
  revision: 0,
  createdAt: 0,
  stateSince: 0,
  phaseSince: 0,
  completedAt: null,
  clearedAt: null,
  priority: null,
  attempt: 1,
  attempts: [],
  history: [],
  search: null,
  release,
  transferHash: 'hash',
  clientId: 'client',
  manualMatch: null,
  importResult: null,
  ...change,
});

describe('torrentsForRemoval', () => {
  it('takes the torrent of a removed title', () => {
    expect(torrentsForRemoval([entry('movie:2')], [])).toEqual([{ clientId: 'client', hash: 'hash' }]);
  });

  it('takes a shared torrent once', () => {
    expect(torrentsForRemoval([entry('tv:1:1x1'), entry('tv:1:1x2')], [])).toEqual([{ clientId: 'client', hash: 'hash' }]);
  });

  it('keeps a torrent that a target outside the removal still uses', () => {
    expect(torrentsForRemoval([entry('tv:1:1x1')], [entry('tv:1:2x1')])).toEqual([]);
  });

  it.each(['client', null])('keeps a shared torrent while another season waits to retry with client %s', (clientId) => {
    const other = entry('tv:1:2x1', {
      state: { kind: 'queued' }, clientId: null, transferHash: null, retryDownload: { hash: 'hash', clientId, match: null },
    });
    expect(torrentsForRemoval([entry('tv:1:1x1')], [other])).toEqual([]);
  });

  it('takes a torrent that the user attached', () => {
    expect(torrentsForRemoval([entry('movie:2', { release: { ...release, external: true } })], [])).toEqual([{ clientId: 'client', hash: 'hash' }]);
  });

  it('takes the pack once when only some of its episodes mark it as external', () => {
    expect(torrentsForRemoval([entry('tv:1:1x1', { release: { ...release, external: true } }), entry('tv:1:1x2')], [])).toEqual([{ clientId: 'client', hash: 'hash' }]);
  });

  it('ignores a target that has no torrent or no client', () => {
    expect(torrentsForRemoval([entry('movie:2', { transferHash: null })], [])).toEqual([]);
    expect(torrentsForRemoval([entry('movie:2', { clientId: null })], [])).toEqual([]);
  });
});
