import type { LogEntry } from '@ladarr/shared/types';

export type LinkedRequest = { ids: string[]; label?: string };

const objectOf = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined);

// The requests that a log line links to. A search line holds one for each indexer that answered, and a line of one
// request holds its own id. The name of the system is the label of a request that is not an indexer.
// The requests of one label share one button, because a series sends several queries to the same indexer.
export function linkedRequests(entry: LogEntry): LinkedRequest[] {
  const found: { id: string; label?: string }[] = [];
  const add = (value: unknown, name?: unknown, system?: unknown) => {
    const id = typeof value === 'string' ? value : null;
    if (!id) return;
    const label = typeof name === 'string' ? name : typeof system === 'string' ? system : undefined;
    const known = found.find((item) => item.id === id);
    if (known) {
      if (known.label === undefined && label) known.label = label;
      return;
    }
    found.push({ id, ...(label ? { label } : {}) });
  };
  add(entry.requestId, entry.indexer, entry.system);
  for (const item of Array.isArray(entry.requests) ? entry.requests : []) {
    const request = objectOf(item);
    add(request?.requestId, request?.indexer, request?.system);
  }
  const list: LinkedRequest[] = [];
  for (const { id, label } of found) {
    const shared = label ? list.find((item) => item.label === label) : undefined;
    if (shared) shared.ids.push(id);
    else list.push({ ids: [id], ...(label ? { label } : {}) });
  }
  return list;
}
