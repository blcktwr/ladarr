import { describe as suite, expect, it } from 'vitest';
import { aggregate, canRetry, describe, isActiveState, phaseOf } from '@ladarr/shared/queue';
import type { Aggregate, Description, Problem, QueueState, Status } from '@ladarr/shared/queue';

const connectionLost: Problem = { code: 'client_error', detail: 'connection reset by peer' };
const noFile: Problem = { code: 'file_not_found', detail: 'no such file or directory' };
const timeout: Problem = { code: 'timeout' };

type Case = { name: string; state: QueueState; expected: Description };

const cases: Case[] = [
  {
    name: 'queued',
    state: { kind: 'queued' },
    expected: { status: 'queued', tab: 'queued', phase: 'queued', active: true, working: true, problem: null },
  },
  {
    name: 'searching',
    state: { kind: 'searching' },
    expected: { status: 'searching', tab: 'searching', phase: 'searching', active: true, working: true, problem: null },
  },
  {
    name: 'fetching',
    state: { kind: 'fetching' },
    expected: { status: 'fetching', tab: 'searching', phase: 'fetching', active: true, working: true, problem: null },
  },
  {
    name: 'sending',
    state: { kind: 'sending' },
    expected: { status: 'sending', tab: null, phase: 'sending', active: true, working: true, problem: null },
  },
  {
    name: 'downloading',
    state: { kind: 'downloading' },
    expected: { status: 'downloading', tab: 'downloading', phase: 'downloading', active: true, working: true, problem: null },
  },
  {
    name: 'validating',
    state: { kind: 'validating' },
    expected: { status: 'validating', tab: 'importing', phase: 'validating', active: true, working: true, problem: null },
  },
  {
    name: 'importing',
    state: { kind: 'importing' },
    expected: { status: 'importing', tab: 'importing', phase: 'importing', active: true, working: true, problem: null },
  },
  {
    name: 'waiting after no results',
    state: { kind: 'waiting', outcome: 'no_results' },
    expected: { status: 'not_found', tab: 'queued', phase: 'queued', active: true, working: false, problem: null },
  },
  {
    name: 'waiting after all releases were rejected',
    state: { kind: 'waiting', outcome: 'all_rejected' },
    expected: { status: 'no_match', tab: 'queued', phase: 'queued', active: true, working: false, problem: null },
  },
  {
    name: 'blocked while downloading',
    state: { kind: 'blocked', at: 'downloading', problem: connectionLost },
    expected: { status: 'stuck', tab: 'stuck', phase: 'downloading', active: true, working: false, problem: connectionLost },
  },
  {
    name: 'paused without a problem',
    state: { kind: 'paused', resume: 'downloading', problem: null },
    expected: { status: 'paused', tab: null, phase: 'downloading', active: true, working: false, problem: null },
  },
  {
    name: 'paused while validating',
    state: { kind: 'paused', resume: 'validating', problem: noFile },
    expected: { status: 'paused', tab: null, phase: 'validating', active: true, working: false, problem: noFile },
  },
  {
    name: 'cancelled while searching',
    state: { kind: 'cancelled', at: 'searching' },
    expected: { status: 'cancelled', tab: null, phase: 'searching', active: false, working: false, problem: null },
  },
  {
    name: 'available',
    state: { kind: 'available' },
    expected: { status: 'available', tab: null, phase: 'available', active: false, working: false, problem: null },
  },
];

// A waiting state that is neither not_found nor no_match keeps the searching status.
for (const outcome of ['deferred', 'indexers_failed', 'unspecified'] as const) {
  cases.push({
    name: `waiting after ${outcome}`,
    state: { kind: 'waiting', outcome },
    expected: { status: 'searching', tab: 'searching', phase: 'queued', active: true, working: false, problem: null },
  });
}

const stateForStatus: Record<Status, QueueState> = {
  queued: { kind: 'queued' },
  searching: { kind: 'searching' },
  fetching: { kind: 'fetching' },
  sending: { kind: 'sending' },
  downloading: { kind: 'downloading' },
  validating: { kind: 'validating' },
  importing: { kind: 'importing' },
  available: { kind: 'available' },
  not_found: { kind: 'waiting', outcome: 'no_results' },
  no_match: { kind: 'waiting', outcome: 'all_rejected' },
  stuck: { kind: 'blocked', at: 'downloading', problem: timeout },
  paused: { kind: 'paused', resume: 'downloading', problem: null },
  cancelled: { kind: 'cancelled', at: 'downloading' },
};

const precedence: Exclude<Status, 'available'>[] = [
  'stuck',
  'searching',
  'fetching',
  'sending',
  'downloading',
  'validating',
  'importing',
  'not_found',
  'no_match',
  'queued',
  'paused',
  'cancelled',
];

suite('describe', () => {
  for (const { name, state, expected } of cases) {
    it(`describes ${name}`, () => {
      expect(describe(state)).toEqual(expected);
    });
  }

});

suite('phaseOf', () => {
  for (const { name, state, expected } of cases) {
    it(`reports ${expected.phase} for ${name}`, () => {
      expect(phaseOf(state)).toBe(expected.phase);
    });
  }
});

suite('isActiveState', () => {
  for (const { name, state, expected } of cases) {
    it(`reports ${expected.active} for ${name}`, () => {
      expect(isActiveState(state)).toBe(expected.active);
    });
  }
});

// A retry takes a target that a problem stops, and a target that waits for its next search with a result. Every other
// target is in the journey, paused, or out of the queue, so a retry would take the work from it.
suite('canRetry', () => {
  const retryable: Status[] = ['stuck', 'not_found', 'no_match'];

  for (const status of retryable) {
    it(`takes ${status}`, () => expect(canRetry(stateForStatus[status])).toBe(true));
  }

  for (const status of (Object.keys(stateForStatus) as Status[]).filter((key) => !retryable.includes(key))) {
    it(`leaves ${status}`, () => expect(canRetry(stateForStatus[status])).toBe(false));
  }
});

suite('aggregate', () => {
  it('returns empty values for no states', () => {
    const result: Aggregate = aggregate([]);
    expect(result).toEqual({ status: null, counts: {}, tabs: [], total: 0, problem: null });
  });

  it('counts every member by its status', () => {
    const states: QueueState[] = [
      { kind: 'queued' },
      { kind: 'queued' },
      { kind: 'waiting', outcome: 'no_results' },
      { kind: 'blocked', at: 'importing', problem: timeout },
      { kind: 'available' },
    ];
    const result = aggregate(states);
    expect(result.total).toBe(5);
    expect(result.counts).toEqual({ queued: 2, not_found: 1, stuck: 1, available: 1 });
  });

  it('uses only the tab of the aggregate status', () => {
    const states: QueueState[] = [
      { kind: 'blocked', at: 'downloading', problem: timeout },
      { kind: 'validating' },
      { kind: 'queued' },
      { kind: 'downloading' },
      { kind: 'sending' },
      { kind: 'searching' },
      { kind: 'queued' },
      { kind: 'fetching' },
      { kind: 'paused', resume: 'importing', problem: null },
    ];
    expect(aggregate(states).tabs).toEqual(['stuck']);
  });

  it('lists no tabs when every member has none', () => {
    const states: QueueState[] = [
      { kind: 'sending' },
      { kind: 'paused', resume: 'downloading', problem: null },
      { kind: 'available' },
    ];
    expect(aggregate(states).tabs).toEqual([]);
  });

  it.each(precedence)('picks %s when it is the highest-precedence status present', (status) => {
    const start = precedence.indexOf(status);
    const states = precedence.slice(start).map((member) => stateForStatus[member]);
    expect(aggregate(states).status).toBe(status);
    const tab = describe(stateForStatus[status]).tab;
    expect(aggregate(states).tabs).toEqual(tab ? [tab] : []);
  });

  it('reports available when every member is available', () => {
    const states: QueueState[] = [{ kind: 'available' }, { kind: 'available' }];
    const result = aggregate(states);
    expect(result.status).toBe('available');
    expect(result.counts).toEqual({ available: 2 });
  });

  it('ignores available members when another status is present', () => {
    const states: QueueState[] = [{ kind: 'available' }, { kind: 'queued' }, { kind: 'available' }];
    expect(aggregate(states).status).toBe('queued');
  });

  it('returns null for the problem when nothing is blocked', () => {
    const states: QueueState[] = [
      { kind: 'paused', resume: 'validating', problem: noFile },
      { kind: 'downloading' },
      { kind: 'waiting', outcome: 'indexers_failed' },
    ];
    expect(aggregate(states).problem).toBeNull();
  });

  it('returns the problem of the most frequent blocked code', () => {
    const states: QueueState[] = [
      { kind: 'blocked', at: 'downloading', problem: connectionLost },
      { kind: 'blocked', at: 'importing', problem: connectionLost },
      { kind: 'blocked', at: 'downloading', problem: timeout },
    ];
    expect(aggregate(states).problem).toEqual(connectionLost);
  });

  it('breaks a tie between codes alphabetically', () => {
    const states: QueueState[] = [
      { kind: 'blocked', at: 'downloading', problem: timeout },
      { kind: 'blocked', at: 'validating', problem: noFile },
    ];
    expect(aggregate(states).problem).toEqual(noFile);
    expect(aggregate([...states].reverse()).problem).toEqual(noFile);
  });

  it('does not depend on the order of the input', () => {
    const states: QueueState[] = [
      { kind: 'downloading' },
      { kind: 'queued' },
      { kind: 'waiting', outcome: 'all_rejected' },
      { kind: 'blocked', at: 'validating', problem: noFile },
      { kind: 'blocked', at: 'importing', problem: timeout },
      { kind: 'cancelled', at: 'downloading' },
    ];
    const forward = aggregate(states);
    const backward = aggregate([...states].reverse());

    expect(forward.status).toBe('stuck');
    expect(forward.total).toBe(6);
    expect(forward.tabs).toEqual(['stuck']);
    expect(backward.status).toBe(forward.status);
    expect(backward.total).toBe(forward.total);
    expect(backward.counts).toEqual(forward.counts);
    expect(backward.tabs).toEqual(forward.tabs);
    expect(backward.problem).toEqual(forward.problem);
    expect(backward.problem).toEqual(noFile);
  });
});
