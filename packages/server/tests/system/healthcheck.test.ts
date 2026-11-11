import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { open } from '../../src/core/db.ts';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../src/system/healthcheck.ts', import.meta.url));

// Starts the script as Docker does, and returns its exit code.
async function exitCode(env: Record<string, string>) {
  try {
    await run(process.execPath, [script], { env: { ...process.env, ...env } });
    return 0;
  } catch (error) {
    return (error as { code: number }).code;
  }
}

let close = () => {};
afterEach(() => close());

async function serve(heartbeat: () => number, urlBase?: string) {
  await open('unused.json');
  const server = createApp({ heartbeat, urlBase }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  close = () => {
    server.closeAllConnections();
    server.close();
  };
  return String((server.address() as AddressInfo).port);
}

describe('health check script', () => {
  it('exits with 0 when the server answers and the worker runs', async () => {
    expect(await exitCode({ PORT: await serve(Date.now) })).toBe(0);
  });

  it('exits with 1 when the worker does not run', async () => {
    expect(await exitCode({ PORT: await serve(() => Date.now() - 60_000) })).toBe(1);
  });

  it('exits with 1 when no server answers', async () => {
    const port = await serve(Date.now);
    close();
    expect(await exitCode({ PORT: port })).toBe(1);
  });

  it('asks under the URL base', async () => {
    const PORT = await serve(Date.now, '/ladarr');
    expect(await exitCode({ PORT, LADARR_URL_BASE: '/ladarr/' })).toBe(0);
    expect(await exitCode({ PORT })).toBe(1);
  });
});
