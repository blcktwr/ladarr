import { db } from '../../core/db.ts';
import { ClientError, createQbittorrent } from './qbittorrent.ts';
import type { ClientCheck, ClientConfig, ClientHandle, Clients, Torrent } from '../../types.ts';

// One inventory for each client. A read that runs now serves every caller that follows it, so a search, a retry, the
// poll, and the send do not ask the client for the same list. The time is short: the queue needs a current answer, and
// a caller that must see its own change asks again with `invalidate`.
const INVENTORY_MS = 2_000;

export function createClients(fetchImpl?: typeof fetch): Clients {
  const handles = new Map<string, { key: string; handle: ClientHandle }>();
  const cache = new Map<string, { at: number; list: Torrent[] }>();
  const inflight = new Map<string, Promise<Torrent[]>>();
  const all = () => {
    const list = db.data.downloadClients
      .filter((config) => config.enabled)
      .map((config) => {
        const key = JSON.stringify(config);
        let item = handles.get(config.id);
        if (!item || item.key !== key) handles.set(config.id, (item = { key, handle: { id: config.id, api: createQbittorrent(config, { fetch: fetchImpl }), config } }));
        return item.handle;
      });
    for (const id of handles.keys()) if (!list.some((handle) => handle.id === id)) handles.delete(id);
    return list;
  };

  async function list(handle: ClientHandle, { fresh = false }: { fresh?: boolean } = {}) {
    const hit = fresh ? undefined : cache.get(handle.id);
    if (hit && Date.now() - hit.at < INVENTORY_MS) return hit.list;
    const pending = fresh ? undefined : inflight.get(handle.id);
    if (pending) return pending;
    const request = handle.api
      .list()
      .then((torrents) => {
        cache.set(handle.id, { at: Date.now(), list: torrents });
        return torrents;
      })
      .finally(() => {
        if (inflight.get(handle.id) === request) inflight.delete(handle.id);
      });
    inflight.set(handle.id, request);
    return request;
  }

  return {
    all,
    get: (id) => (id ? all().find((handle) => handle.id === id) : undefined),
    next: () => all()[0],
    list,
    find: async (handle, hash) => (await list(handle)).find((torrent) => torrent.hash === hash) ?? null,
    byHashes: async (handle, hashes) => {
      const wanted = new Set(hashes);
      return (await list(handle)).filter((torrent) => wanted.has(torrent.hash));
    },
    invalidate: (handle) => {
      cache.delete(handle.id);
    },
  };
}

// A check of the clients that are on, for the health list. The state is the worst one. The answer is kept for a minute, so a page that reloads does not sign in each time.
export function createClientCheck(clients: Clients, ttlMs = 60_000) {
  let last: { at: number; key: string; result: ClientCheck } | undefined;
  return async (): Promise<ClientCheck> => {
    const handles = clients.all();
    if (!handles.length) return 'unconfigured';
    const key = JSON.stringify(handles.map((handle) => handle.config));
    if (last && last.key === key && Date.now() - last.at < ttlMs) return last.result;
    let result: ClientCheck = 'ok';
    for (const handle of handles) {
      try {
        await handle.api.test();
      } catch (error) {
        const state = error instanceof ClientError && error.code === 'rejected' ? 'rejected' : 'unreachable';
        if (result === 'ok' || state === 'rejected') result = state;
      }
    }
    last = { at: Date.now(), key, result };
    return result;
  };
}
