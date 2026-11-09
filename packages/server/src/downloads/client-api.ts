import type { ClientState } from '@ladarr/shared/enums';
import type { ClientTestResult, ClientView } from '@ladarr/shared/types';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Db } from '../core/db.ts';
import { ClientError, clientUrl, createQbittorrent, type ClientAuth, type ClientConfig, type ClientHandle } from './qbittorrent.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The most downloads that a client can have at once.
const MAX_DOWNLOADS = 100;

// The clients that are on. A change of the settings makes the connection of that client again.
export type Clients = {
  all: () => ClientHandle[];
  get: (id: string | null | undefined) => ClientHandle | undefined;
  // The client that gets the next download: the first one of the list.
  next: () => ClientHandle | undefined;
};

export function createClients(db: Db, fetchImpl?: typeof fetch): Clients {
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

// The user sees the settings of a client without the secrets.
const view = ({ id, name, type, host, port, auth, enabled, maxDownloads }: ClientConfig): ClientView => ({ id, name, type, host, port, auth: auth.type, username: auth.type === 'password' ? auth.username : null, enabled, maxDownloads });

// A client that exists keeps a secret that the body leaves out, because the user does not see the secrets.
function parse(body: unknown, existing?: ClientConfig): { config: Omit<ClientConfig, 'id'> } | { invalid: string } {
  if (!isObject(body)) return { invalid: 'body' };
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const name = text(body.name);
  if (!name || name.length > 100) return { invalid: 'name' };
  if (body.type !== 'qbittorrent') return { invalid: 'type' };
  const host = text(body.host);
  const port = body.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return { invalid: 'port' };
  if (!host || host.length > 255 || !clientUrl({ host, port })) return { invalid: 'host' };
  const input = isObject(body.auth) ? body.auth : {};
  let auth: ClientAuth;
  if (input.type === 'apiKey') {
    const apiKey = text(input.apiKey) || (existing?.auth.type === 'apiKey' ? existing.auth.apiKey : '');
    if (!apiKey || apiKey.length > 200) return { invalid: 'apiKey' };
    auth = { type: 'apiKey', apiKey };
  } else if (input.type === 'password') {
    const username = text(input.username);
    const password = typeof input.password === 'string' ? input.password : existing?.auth.type === 'password' ? existing.auth.password : '';
    if (!username || username.length > 100 || password.length > 200) return { invalid: 'username' };
    auth = { type: 'password', username, password };
  } else return { invalid: 'auth' };
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return { invalid: 'enabled' };
  const maxDownloads = body.maxDownloads ?? existing?.maxDownloads ?? 0;
  if (typeof maxDownloads !== 'number' || !Number.isInteger(maxDownloads) || maxDownloads < 0 || maxDownloads > MAX_DOWNLOADS) return { invalid: 'maxDownloads' };
  return { config: { name, type: body.type, host, port, auth, enabled: body.enabled ?? true, maxDownloads } };
}

export function clientsRouter(db: Db, { fetch: fetchImpl, onChange = () => {} }: { fetch?: typeof fetch; onChange?: () => void } = {}) {
  const router = Router();

  // Signs in, and reads the versions. It saves nothing.
  async function test(config: ClientConfig): Promise<ClientTestResult> {
    try {
      return { ok: true, ...(await createQbittorrent(config, { fetch: fetchImpl }).test()) };
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      return { ok: false, code: error.code };
    }
  }

  router.get('/', (_req, res) => void res.json({ clients: db.data.downloadClients.map(view) }));

  router.post('/', async (req, res) => {
    const result = parse(req.body);
    if ('invalid' in result) return void res.status(400).json({ error: 'invalid_setting', field: result.invalid });
    const config: ClientConfig = { id: randomUUID(), ...result.config };
    db.data.downloadClients.push(config);
    await db.write();
    onChange();
    res.status(201).json({ client: view(config) });
  });

  // A check of the settings of the form, before the user saves them.
  router.post('/test', async (req, res) => {
    const result = parse(req.body);
    if ('invalid' in result) return void res.status(400).json({ error: 'invalid_setting', field: result.invalid });
    res.json(await test({ id: '', ...result.config }));
  });

  // Tests the saved client, or the settings of the body when it has some, before the user saves them.
  router.post('/:id/test', async (req, res) => {
    const config = db.data.downloadClients.find((item) => item.id === req.params.id);
    if (!config) return void res.status(404).json({ error: 'not_found' });
    if (!isObject(req.body) || !Object.keys(req.body).length) return void res.json(await test(config));
    const result = parse(req.body, config);
    if ('invalid' in result) return void res.status(400).json({ error: 'invalid_setting', field: result.invalid });
    res.json(await test({ id: config.id, ...result.config }));
  });

  router.put('/:id', async (req, res) => {
    const config = db.data.downloadClients.find((item) => item.id === req.params.id);
    if (!config) return void res.status(404).json({ error: 'not_found' });
    const result = parse(req.body, config);
    if ('invalid' in result) return void res.status(400).json({ error: 'invalid_setting', field: result.invalid });
    Object.assign(config, result.config);
    await db.write();
    onChange();
    res.json({ client: view(config) });
  });

  // The downloads of a client that is gone stay in the queue. The poller marks their numbers as old, as it does for a client that is off.
  router.delete('/:id', async (req, res) => {
    const index = db.data.downloadClients.findIndex((item) => item.id === req.params.id);
    if (index < 0) return void res.status(404).json({ error: 'not_found' });
    db.data.downloadClients.splice(index, 1);
    await db.write();
    onChange();
    res.status(204).end();
  });

  return router;
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
