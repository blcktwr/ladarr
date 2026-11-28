export type SelectMode = 'one' | 'toggle' | 'range';

// The selection after the user selects a row. `order` holds the visible rows that the user can select, from top to bottom.
export function select(selected: string[], anchor: string | null, order: string[], id: string, mode: SelectMode): { selected: string[]; anchor: string } {
  if (mode === 'toggle') return { selected: selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id], anchor: id };
  if (mode === 'range' && anchor !== null && order.includes(anchor)) {
    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    return { selected: order.slice(Math.min(from, to), Math.max(from, to) + 1), anchor };
  }
  return { selected: [id], anchor: id };
}
