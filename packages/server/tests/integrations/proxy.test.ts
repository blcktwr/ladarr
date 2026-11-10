import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnqueueInput } from '../../src/core/jobs.ts';
import { createClients } from '../../src/library/downloads/client-api.ts';
import { radarr } from '../../src/proxy/radarr.ts';
import { seerr } from '../../src/proxy/seerr.ts';
import { sonarr } from '../../src/proxy/sonarr.ts';
import { FakeRadarr, FakeSonarr } from '../helpers/test-seerr.ts';
import { startPipeline } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  await pipe?.stop();
  pipe = undefined;
});

async function listen(app: Express) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function start() {
  pipe = await startPipeline();
  pipe.db.data.apiKey = 'key';
  const services = { queue: pipe.queue, finder: pipe.finder, poller: pipe.poller, clients: createClients(), importStatus: pipe.importStatus };
  const { events, worker } = pipe;
  const deps = { events, enqueue: (input: EnqueueInput) => worker.enqueue(input), services };
  const sonarrUrl = await listen(sonarr(deps));
  const radarrUrl = await listen(radarr(deps));
  const seerrUrl = await listen(seerr(deps));
  return {
    key: pipe.db.data.apiKey,
    sonarr: new FakeSonarr(`${sonarrUrl}/api/v3`, pipe.db.data.apiKey),
    radarr: new FakeRadarr(`${radarrUrl}/api/v3`, pipe.db.data.apiKey),
    sonarrUrl,
    seerrUrl,
  };
}

describe('proxy ports', () => {
  it('serves the Sonarr API at the root of its port', async () => {
    const { sonarr } = await start();
    expect(await sonarr.getSystemStatus()).toMatchObject({ appName: 'Sonarr', version: '4.0.0.0', urlBase: '' });
    expect(await sonarr.getProfiles()).toEqual([
      { id: 1, name: '1080p' },
      { id: 2, name: '2160p' },
    ]);
  });

  it('serves the Radarr API at the root of its port', async () => {
    const { radarr } = await start();
    expect(await radarr.getSystemStatus()).toMatchObject({ appName: 'Radarr', version: '5.0.0.0', urlBase: '' });
  });

  it('serves the Seerr API at /api/v1 of its port', async () => {
    const { seerrUrl } = await start();
    const status = await fetch(`${seerrUrl}/api/v1/status`);
    expect(await status.json()).toEqual({ version: '3.5.1', commitTag: 'ladarr' });
  });

  it('needs the API key on each port and hides the native API', async () => {
    const { sonarrUrl } = await start();
    expect((await fetch(`${sonarrUrl}/api/v3/qualityProfile`)).status).toBe(401);
    expect((await fetch(`${sonarrUrl}/api/health`)).status).toBe(404);
  });
});
