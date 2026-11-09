// The arithmetic of a windowed list. The list draws only the items near the viewport.

// offsets[i] is the top of item i. offsets[n] is the height of the whole list.
export function buildOffsets(sizes: ArrayLike<number>): Float64Array {
  const offsets = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) offsets[i + 1] = offsets[i]! + sizes[i]!;
  return offsets;
}

// The item that holds the height y. A height above the list gives the first item, and a height below it gives the last.
export function indexAt(offsets: Float64Array, y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let low = 0;
  let high = n - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

// The runs of items to draw: the items in the viewport plus the overscan, and the pinned item (it holds the keyboard focus).
// A run is [start, end) and the runs are in order, apart, and not empty.
export function plan(offsets: Float64Array, top: number, height: number, overscan: number, pinned: number | null): [number, number][] {
  const n = offsets.length - 1;
  if (n <= 0) return [];
  const start = indexAt(offsets, top - overscan);
  const end = Math.min(n, indexAt(offsets, top + height + overscan) + 1);
  const runs: [number, number][] = [[start, end]];
  if (pinned !== null && pinned >= 0 && pinned < n && (pinned < start || pinned >= end)) {
    if (pinned < start) runs.unshift([pinned, pinned + 1]);
    else runs.push([pinned, pinned + 1]);
    // Touching runs are one run.
    if (runs[0]![1] === runs[1]![0]) runs.splice(0, 2, [runs[0]![0], runs[1]![1]]);
  }
  return runs;
}

export const drawn = (runs: [number, number][]) => runs.reduce((sum, [start, end]) => sum + end - start, 0);
