import { describe, expect, it } from 'vitest';
import { linkedRequests } from './log-links.ts';

describe('linked requests', () => {
  it('links the request of the entry', () => {
    expect(linkedRequests({ time: '', message: '', requestId: 'req-1', indexer: 'Indexer A' })).toEqual([{ ids: ['req-1'], label: 'Indexer A' }]);
  });

  it('links every request of a search line', () => {
    const entry = {
      time: '',
      message: '',
      requests: [
        { indexer: 'Indexer A', requestId: 'req-1', cached: false },
        { indexer: 'Indexer B', requestId: 'req-2', cached: false },
      ],
    };
    expect(linkedRequests(entry)).toEqual([
      { ids: ['req-1'], label: 'Indexer A' },
      { ids: ['req-2'], label: 'Indexer B' },
    ]);
  });

  it('links a request of another system by its name', () => {
    const entry = {
      time: '',
      message: '',
      requests: [{ system: 'TMDB', requestId: 'req-1' }],
    };
    expect(linkedRequests(entry)).toEqual([{ ids: ['req-1'], label: 'TMDB' }]);
  });

  it('leaves out a cache hit and a repeated request', () => {
    const entry = {
      time: '',
      message: '',
      requestId: 'req-1',
      requests: [
        { indexer: 'Indexer A', requestId: 'req-1', cached: false },
        { indexer: 'Indexer B', requestId: null, cached: true },
      ],
    };
    expect(linkedRequests(entry)).toEqual([{ ids: ['req-1'], label: 'Indexer A' }]);
  });

  it('gives one button to the queries of one indexer', () => {
    const entry = {
      time: '',
      message: '',
      requests: [
        { indexer: 'Indexer A', requestId: 'req-1', cached: false },
        { indexer: 'Indexer A', requestId: 'req-2', cached: false },
      ],
    };
    expect(linkedRequests(entry)).toEqual([{ ids: ['req-1', 'req-2'], label: 'Indexer A' }]);
  });

  it('ignores a field that is not a request list', () => {
    expect(linkedRequests({ time: '', message: '', requests: 'none' })).toEqual([]);
    expect(linkedRequests({ time: '', message: '' })).toEqual([]);
  });
});
