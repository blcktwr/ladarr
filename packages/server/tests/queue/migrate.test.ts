import { describe, expect, it } from 'vitest';
import { describe as describeState } from '@ladarr/shared/queue';
import { migrateQueue } from '../../src/library/downloads/queue-migrate.ts';
import type { LegacyEntry } from '../../src/types.ts';

const base = { id: 'movie:1', titleKey: 'movie:1', season: null, number: null, revision: 0, createdAt: 1, completedAt: null, clearedAt: null, priority: null, attempt: 1, attempts: [], history: [], search: null, release: null, transferHash: null, clientId: null, manualMatch: null, importResult: null };

const migrate = (entry: Record<string, unknown>) => {
  const queue = { [entry.id as string]: { ...base, ...entry } } as never;
  migrateQueue(queue);
  return (queue as Record<string, LegacyEntry>)[entry.id as string]!;
};

describe('queue migration', () => {
  it('maps a stage to a state', () => {
    const entry = migrate({ stage: 'downloading', branch: null, reason: null, stageSince: 5 });
    expect(entry.state).toEqual({ kind: 'downloading' });
    expect(entry.stateSince).toBe(5);
    expect(entry.phaseSince).toBe(5);
    expect(entry).not.toHaveProperty('stage');
    expect(entry).not.toHaveProperty('stageSince');
  });

  it('maps a waiting branch to the result of its search', () => {
    expect(describeState(migrate({ stage: 'queued', branch: 'waiting', reason: { code: 'no_results' } }).state!).status).toBe('not_found');
    expect(describeState(migrate({ stage: 'queued', branch: 'waiting', reason: { code: 'all_rejected' } }).state!).status).toBe('no_match');
    expect(describeState(migrate({ stage: 'queued', branch: 'waiting', reason: { code: 'search_deferred' } }).state!).status).toBe('searching');
    expect(describeState(migrate({ stage: 'queued', branch: 'waiting', reason: null }).state!).status).toBe('searching');
  });

  it('maps a problem to a block at its phase', () => {
    const entry = migrate({ stage: 'validating', branch: null, reason: { code: 'file_not_found', detail: 'x' } });
    expect(entry.state).toEqual({ kind: 'blocked', at: 'importing', problem: { code: 'file_not_found', detail: 'x' } });
  });

  it('keeps a pause with its phase and its problem', () => {
    expect(migrate({ stage: 'downloading', branch: 'paused', reason: null }).state).toEqual({ kind: 'paused', resume: 'downloading', problem: null });
    expect(migrate({ stage: 'importing', branch: 'paused', reason: { code: 'disk_full' } }).state).toEqual({
      kind: 'paused',
      resume: 'importing',
      problem: { code: 'disk_full' },
    });
  });

  it('maps a cancel and a completion', () => {
    expect(migrate({ stage: 'searching', branch: 'cancelled', reason: null }).state).toEqual({ kind: 'cancelled', at: 'searching' });
    expect(migrate({ stage: 'available', branch: null, reason: null }).state).toEqual({ kind: 'available' });
  });

  it('maps the removed validation stage to the import, in a state and in its history', () => {
    const entry = migrate({
      state: { kind: 'blocked', at: 'validating', problem: { code: 'file_not_found' } },
      history: [{ at: 2, state: { kind: 'validating' }, stage: 'validating', attempt: 1, cause: 'download complete' }],
    });
    expect(entry.state).toEqual({ kind: 'blocked', at: 'importing', problem: { code: 'file_not_found' } });
    expect(entry.history![0]).toMatchObject({ state: { kind: 'importing' }, stage: 'importing' });
  });

  it('keeps the wait for a slot when it runs again', () => {
    const queue = { 'movie:1': { ...base, state: { kind: 'waiting_slot' }, stateSince: 3, phaseSince: 2 } } as never;
    migrateQueue(queue);
    migrateQueue(queue);
    expect((queue as Record<string, LegacyEntry>)['movie:1']!.state).toEqual({ kind: 'waiting_slot' });
  });

  it('gives a history event its state without inventing a problem', () => {
    const entry = migrate({
      stage: 'queued',
      history: [{ at: 2, stage: 'downloading', branch: null, attempt: 1, cause: 'download complete' }],
    });
    expect(entry.history![0]).toMatchObject({ state: { kind: 'downloading' }, stage: 'downloading', cause: 'download complete' });
    expect(entry.history![0]).not.toHaveProperty('branch');
  });

  it('is idempotent and leaves a current entry alone', () => {
    const queue = { 'movie:1': { ...base, state: { kind: 'blocked', at: 'downloading', problem: { code: 'client_error' } }, stateSince: 3, phaseSince: 2 } } as never;
    migrateQueue(queue);
    migrateQueue(queue);
    expect((queue as Record<string, LegacyEntry>)['movie:1']!.state).toEqual({ kind: 'blocked', at: 'downloading', problem: { code: 'client_error' } });
  });
});
