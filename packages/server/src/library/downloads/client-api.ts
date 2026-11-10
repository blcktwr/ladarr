import type { ClientState } from '@ladarr/shared/enums';
import { db } from '../../core/db.ts';
import { ClientError, createQbittorrent, type ClientConfig, type ClientHandle } from './qbittorrent.ts';

// The clients that are on. A change of the settings makes the connection of that client again.
export type Clients = {
  all: () => ClientHandle[];
  get: (id: string | null | undefined) => ClientHandle | undefined;
  // The client that gets the next download: the first one of the list.
  next: () => ClientHandle | undefined;
};

export function createClients(fetchImpl?: typeof fetch): Clients {
  const handles = new Map<string, { key: string; handle: ClientHandle }>();
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
  return { all, get: (id) => (id ? all().find((handle) => handle.id === id) : undefined), next: () => all()[0] };
}

export type ClientCheck = ClientState;

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
