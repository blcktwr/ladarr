import { describe, expect, it } from 'vitest';
import { buildOffsets, drawn, indexAt, plan } from './window.ts';

describe('windowed list', () => {
  const offsets = buildOffsets(Array.from({ length: 1000 }, () => 100));

  it('finds the item at a height, and clamps outside the list', () => {
    expect(offsets[1000]).toBe(100_000);
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, 99.9)).toBe(0);
    expect(indexAt(offsets, 100)).toBe(1);
    expect(indexAt(offsets, 50_050)).toBe(500);
    expect(indexAt(offsets, -500)).toBe(0);
    expect(indexAt(offsets, 1e9)).toBe(999);
    expect(indexAt(buildOffsets([]), 10)).toBe(0);
  });

  it('draws only the viewport and the overscan, whatever the length of the list', () => {
    const [[start, end]] = plan(offsets, 50_000, 800, 200, null);
    expect([start, end]).toEqual([498, 511]);
    // The same viewport in a list ten times longer draws the same number of items.
    const long = buildOffsets(Array.from({ length: 10_000 }, () => 100));
    expect(drawn(plan(long, 500_000, 800, 200, null))).toBe(13);
  });

  it('clamps at both ends of the list', () => {
    expect(plan(offsets, 0, 800, 200, null)).toEqual([[0, 11]]);
    expect(plan(offsets, 99_500, 800, 200, null)).toEqual([[993, 1000]]);
  });

  it('keeps the pinned item, which holds the focus, drawn when it is far from the viewport', () => {
    expect(plan(offsets, 50_000, 800, 200, 3)).toEqual([[3, 4], [498, 511]]);
    expect(plan(offsets, 50_000, 800, 200, 900)).toEqual([[498, 511], [900, 901]]);
    // Inside the viewport, or next to it, it adds no run.
    expect(plan(offsets, 50_000, 800, 200, 500)).toEqual([[498, 511]]);
    expect(plan(offsets, 50_000, 800, 200, 511)).toEqual([[498, 512]]);
    expect(plan(offsets, 50_000, 800, 200, 497)).toEqual([[497, 511]]);
    // An index that is not in the list is ignored.
    expect(plan(offsets, 0, 800, 200, 5000)).toEqual([[0, 11]]);
  });

  it('uses the real sizes of the items', () => {
    const mixed = buildOffsets([50, 400, 50, 50, 1000, 50]);
    expect(Array.from(mixed)).toEqual([0, 50, 450, 500, 550, 1550, 1600]);
    expect(indexAt(mixed, 449)).toBe(1);
    expect(indexAt(mixed, 450)).toBe(2);
    expect(plan(mixed, 500, 100, 0, null)).toEqual([[3, 5]]);
  });
});
