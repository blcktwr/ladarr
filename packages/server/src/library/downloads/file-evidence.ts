import { relative, sep } from 'node:path';
import type { QueueEntry, Torrent } from '../../types.ts';
import { itemFor } from './queue.ts';

export function acceptedPath(entry: QueueEntry) {
  if (!entry.transferHash || !entry.clientId) return;
  const selection = itemFor(entry)?.selected[entry.transferHash];
  if (selection?.status === 'accepted' && selection.clientId === entry.clientId) {
    return selection.matches[entry.id] ?? undefined;
  }
}

const safe = (path: string) => !/[\\\0]/.test(path) && !/^[a-z]:/i.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..');

export function matchPath<T>(files: T[], pathOf: (file: T) => string, torrent: Torrent) {
  const content = relative(torrent.savePath, torrent.contentPath).split(sep).join('/');
  const roots = [...new Set([content, ...(torrent.name.includes('/') ? [] : [torrent.name])].filter(safe))];
  const withoutRoot = (path: string) => roots.flatMap((root) => path.startsWith(`${root}/`) ? [path.slice(root.length + 1)] : []);
  const exact = new Map<string, T[]>();
  const rootless = new Map<string, T[]>();
  const add = (index: Map<string, T[]>, path: string, file: T) => {
    const existing = index.get(path);
    if (existing) existing.push(file);
    else index.set(path, [file]);
  };
  for (const file of files) {
    const name = pathOf(file);
    if (!safe(name)) continue;
    add(exact, name, file);
    for (const path of withoutRoot(name)) add(rootless, path, file);
  }
  return (path: string) => {
    if (!safe(path)) return;
    const direct = exact.get(path);
    if (direct) return direct.length === 1 ? direct[0] : undefined;
    // A client can include or omit the torrent root. Other directory names must match.
    const matches = [...(rootless.get(path) ?? []), ...withoutRoot(path).flatMap((name) => exact.get(name) ?? [])];
    return matches.length === 1 ? matches[0] : undefined;
  };
}
