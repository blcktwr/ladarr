import type { ClientTestResult, ClientView } from '@ladarr/shared/types';
import { ClientError, clientUrl, createQbittorrent, type ClientAuth, type ClientConfig } from '../library/downloads/qbittorrent.ts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The most downloads that a client can have at once.
const MAX_DOWNLOADS = 100;

// The user sees the settings of a client without the secrets.
export const view = ({ id, name, type, host, port, auth, enabled, maxDownloads }: ClientConfig): ClientView => ({ id, name, type, host, port, auth: auth.type, username: auth.type === 'password' ? auth.username : null, enabled, maxDownloads });

// A client that exists keeps a secret that the body leaves out, because the user does not see the secrets.
export function parse(body: unknown, existing?: ClientConfig): { config: Omit<ClientConfig, 'id'> } | { invalid: string } {
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

// Signs in, and reads the versions. It saves nothing.
export async function testClient(config: ClientConfig): Promise<ClientTestResult> {
  try {
    return { ok: true, ...(await createQbittorrent(config).test()) };
  } catch (error) {
    if (!(error instanceof ClientError)) throw error;
    return { ok: false, code: error.code };
  }
}
