import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildOffsets, plan } from './window.ts';

type Props<T> = {
  items: T[];
  getKey: (item: T) => string;
  // The height of an item that the page has not drawn yet.
  estimate: (item: T) => number;
  render: (item: T, index: number) => ReactNode;
  label: string;
  // The distance in pixels above and below the viewport where items are drawn.
  overscan?: number;
  // The items that are drawn now, [start, end), and the item that has the focus when it is outside that range.
  onRange?: (start: number, end: number, pinned: number | null) => void;
  // Called when the item that had the keyboard focus is gone. The index is the place where focus goes now, or null when the list is empty.
  onFocusMoved?: (index: number | null) => void;
};

// One slot is one item of the list. It reports its own height, because the heights are not equal and they change.
function Slot({ id, index, count, onSize, children }: { id: string; index: number; count: number; onSize: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    onSize(id, element.getBoundingClientRect().height);
    const observer = new ResizeObserver(() => onSize(id, element.getBoundingClientRect().height));
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, onSize]);
  return (
    <div ref={ref} role="listitem" tabIndex={-1} data-vkey={id} aria-posinset={index + 1} aria-setsize={count}>
      {children}
    </div>
  );
}

// A list for the window scroll. It draws the items near the viewport and the item that has the focus.
// The space of the items that it does not draw is two empty blocks, so the scroll bar is true and the page does not jump.
export function VirtualList<T>({ items, getKey, estimate, render, label, overscan = 600, onRange, onFocusMoved }: Props<T>) {
  const root = useRef<HTMLDivElement>(null);
  const sizes = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const [view, setView] = useState({ top: 0, height: typeof window === 'undefined' ? 800 : window.innerHeight });
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const focused = useRef<{ key: string; index: number } | null>(null);
  const anchor = useRef<{ key: string; abs: number } | null>(null);
  const pendingFocus = useRef<string | null>(null);

  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  const keyIndex = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const offsets = useMemo(() => buildOffsets(items.map((item, index) => sizes.current.get(keys[index]!) ?? estimate(item))), [items, keys, estimate, version]);

  const onSize = useCallback((id: string, height: number) => {
    if (sizes.current.get(id) === height) return;
    sizes.current.set(id, height);
    setVersion((value) => value + 1);
  }, []);

  const latest = useRef({ offsets, keys });
  latest.current = { offsets, keys };

  // The item at the top of the viewport. The page keeps it in place when the heights above it change.
  const record = useCallback(() => {
    const element = root.current;
    const { offsets: current, keys: currentKeys } = latest.current;
    if (!element || !currentKeys.length) return void (anchor.current = null);
    const top = element.getBoundingClientRect().top;
    let low = 0;
    let high = currentKeys.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (top + current[mid + 1]! > 0) high = mid;
      else low = mid + 1;
    }
    anchor.current = { key: currentKeys[low]!, abs: window.scrollY + top + current[low]! };
  }, []);

  // The viewport in the coordinates of the list. It changes with the scroll, the size of the window, and the content above the list.
  const measure = useCallback(() => {
    const element = root.current;
    if (!element) return;
    const top = -element.getBoundingClientRect().top;
    setView((current) => (current.top === top && current.height === window.innerHeight ? current : { top, height: window.innerHeight }));
  }, []);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
        record();
      });
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
    };
  }, [measure, record]);
  // Content above the list can change its place without a scroll.
  useEffect(measure);

  // When the heights or the items change, the item at the top of the viewport stays where it was.
  useLayoutEffect(() => {
    const element = root.current;
    const a = anchor.current;
    if (element && a) {
      const index = keyIndex.get(a.key);
      if (index !== undefined) {
        const abs = window.scrollY + element.getBoundingClientRect().top + offsets[index]!;
        if (Math.abs(abs - a.abs) >= 1) window.scrollBy(0, abs - a.abs);
      }
    }
    record();
  }, [offsets, keyIndex, record]);

  // The item with the focus stays in the DOM. When it leaves the list, the focus goes to the item at the same place.
  useLayoutEffect(() => {
    const current = focused.current;
    if (!current) return;
    if (keyIndex.has(current.key)) {
      current.index = keyIndex.get(current.key)!;
      return;
    }
    if (document.activeElement && document.activeElement !== document.body) {
      focused.current = null;
      return;
    }
    const index = items.length ? Math.min(current.index, items.length - 1) : null;
    focused.current = null;
    // The row at the same place can be outside the drawn rows. The pin draws it, and the next effect moves the focus to it.
    pendingFocus.current = index === null ? null : keys[index]!;
    setPinnedKey(index === null ? null : keys[index]!);
    onFocusMoved?.(index);
  }, [keyIndex, items.length, keys, onFocusMoved]);

  // Moves the focus to the row that waits for it, as soon as that row is in the DOM.
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    // The focus went somewhere else, or the row is gone. Nothing waits then.
    if ((document.activeElement && document.activeElement !== document.body) || !keyIndex.has(key)) {
      pendingFocus.current = null;
      return;
    }
    const slot = root.current?.querySelector<HTMLElement>(`[data-vkey="${CSS.escape(key)}"]`);
    if (!slot) return;
    pendingFocus.current = null;
    slot.focus({ preventScroll: true });
    focused.current = { key, index: keyIndex.get(key)! };
  });

  const pinned = pinnedKey === null ? null : (keyIndex.get(pinnedKey) ?? null);
  const runs = plan(offsets, view.top, view.height, overscan, pinned);
  const [start, end] = plan(offsets, view.top, view.height, overscan, null)[0] ?? [0, 0];
  const report = useRef(onRange);
  report.current = onRange;
  // The items change when pages load or groups open. The same range can then cover other rows.
  const outside = pinned !== null && (pinned < start || pinned >= end) ? pinned : null;
  useEffect(() => report.current?.(start, end, outside), [start, end, items, outside]);

  const children: ReactNode[] = [];
  let cursor = 0;
  runs.forEach(([from, to], run) => {
    children.push(<div key={`gap${run}`} aria-hidden="true" style={{ height: offsets[from]! - offsets[cursor]! }} />);
    for (let index = from; index < to; index++) {
      children.push(
        <Slot key={keys[index]} id={keys[index]!} index={index} count={items.length} onSize={onSize}>
          {render(items[index]!, index)}
        </Slot>,
      );
    }
    cursor = to;
  });
  if (runs.length) children.push(<div key="end" aria-hidden="true" style={{ height: offsets[items.length]! - offsets[cursor]! }} />);

  return (
    <div
      ref={root}
      role="list"
      aria-label={label}
      // The list keeps the place of the rows by itself. The browser must not move the page a second time.
      style={{ overflowAnchor: 'none', width: '100%' }}
      onFocus={(event) => {
        const slot = (event.target as HTMLElement).closest<HTMLElement>('[data-vkey]');
        const key = slot?.dataset.vkey;
        if (!key) return;
        focused.current = { key, index: keyIndex.get(key) ?? 0 };
        setPinnedKey(key);
      }}
      onBlur={(event) => {
        // The focus went to another part of the page on purpose. A dialog from a row keeps its row, because the focus returns there.
        if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node) && !(event.relatedTarget as HTMLElement).closest('[role="dialog"]')) focused.current = null;
      }}
    >
      {children}
    </div>
  );
}
