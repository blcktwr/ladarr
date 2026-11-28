import { describe, expect, it } from 'vitest';
import { select, type SelectMode } from './selection.ts';

const ORDER = ['a', 'b', 'c', 'd'];

// The order of the selected ids has no meaning, so the checks sort them.
function run(selected: string[], anchor: string | null, id: string, mode: SelectMode, order = ORDER) {
  const result = select(selected, anchor, order, id, mode);
  return { selected: result.selected.toSorted(), anchor: result.anchor };
}

describe('one', () => {
  it('selects only the row, and makes it the anchor', () => {
    expect(run(['a', 'b'], 'a', 'c', 'one')).toEqual({ selected: ['c'], anchor: 'c' });
  });

  it('keeps a selected row as the only selection', () => {
    expect(run(['a', 'b'], 'a', 'b', 'one')).toEqual({ selected: ['b'], anchor: 'b' });
  });
});

describe('toggle', () => {
  it('adds a row to the selection, and makes it the anchor', () => {
    expect(run(['a'], 'a', 'c', 'toggle')).toEqual({ selected: ['a', 'c'], anchor: 'c' });
  });

  it('removes a selected row, and makes it the anchor', () => {
    expect(run(['a', 'c'], 'a', 'c', 'toggle')).toEqual({ selected: ['a'], anchor: 'c' });
  });

  it('can remove the last selected row', () => {
    expect(run(['b'], 'b', 'b', 'toggle')).toEqual({ selected: [], anchor: 'b' });
  });
});

describe('range', () => {
  it('selects the rows from the anchor down to the row, and keeps the anchor', () => {
    expect(run(['b'], 'b', 'd', 'range')).toEqual({ selected: ['b', 'c', 'd'], anchor: 'b' });
  });

  it('selects the rows from the anchor up to the row', () => {
    expect(run(['c'], 'c', 'a', 'range')).toEqual({ selected: ['a', 'b', 'c'], anchor: 'c' });
  });

  it('replaces the earlier selection with the range', () => {
    expect(run(['a', 'b', 'c', 'd'], 'b', 'c', 'range')).toEqual({ selected: ['b', 'c'], anchor: 'b' });
  });

  it('selects the anchor only when the row is the anchor', () => {
    expect(run(['a', 'b'], 'b', 'b', 'range')).toEqual({ selected: ['b'], anchor: 'b' });
  });

  it('takes only the rows of the order', () => {
    expect(run(['a'], 'a', 'd', 'range', ['a', 'c', 'd'])).toEqual({ selected: ['a', 'c', 'd'], anchor: 'a' });
  });

  it('selects only the row when the anchor is hidden', () => {
    expect(run(['b'], 'b', 'd', 'range', ['a', 'c', 'd'])).toEqual({ selected: ['d'], anchor: 'd' });
  });

  it('selects only the row without an anchor', () => {
    expect(run([], null, 'c', 'range')).toEqual({ selected: ['c'], anchor: 'c' });
  });
});
