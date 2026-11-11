import { describe, expect, it } from 'vitest';
import { torrentsForRemoval } from '../../src/library/tools/remove.ts';
import type { QueueEntry } from '../../src/library/downloads/queue.ts';

const release = { guid: 'release', indexerId: 1, indexerName: 'Indexer', title: 'Release', sizeBytes: 1, infoHash: 'hash', link: null, magnet: null, kind: 'single' as const, seeders: 1, manual: false };

const entry = (id: string, change: Partial<QueueEntry> = {}): QueueEntry => ({
  id,
  titleKey: id.startsWith('movie:') ? id : 'tv:1',
  season: null,
  number: null,
  stage: 'downloading',
  branch: null,
  reason: null,
  revision: 0,
  createdAt: 0,
  stageSince: 0,
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

  it('keeps a torrent that the user attached', () => {
    expect(torrentsForRemoval([entry('movie:2', { release: { ...release, external: true } })], [])).toEqual([]);
  });

  it('keeps a torrent when an attached target shares it with a removed target', () => {
    expect(torrentsForRemoval([entry('movie:2', { release: { ...release, external: true } }), entry('movie:3')], [])).toEqual([]);
  });

  it('ignores a target that has no torrent or no client', () => {
    expect(torrentsForRemoval([entry('movie:2', { transferHash: null })], [])).toEqual([]);
    expect(torrentsForRemoval([entry('movie:2', { clientId: null })], [])).toEqual([]);
  });
});
