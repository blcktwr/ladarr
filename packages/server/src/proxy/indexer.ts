import express, { Router } from 'express';
import { adapterHeaders } from '../helpers/indexers-adapter.ts';
import { indexerSystemStatus } from '../routes/indexers/adapter/system/status/get.ts';
import { indexerSchemaGet } from '../routes/indexers/adapter/indexer/schema/get.ts';
import { indexerListGet } from '../routes/indexers/adapter/indexer/get.ts';
import { indexerGet } from '../routes/indexers/adapter/indexer/[id]/get.ts';
import { indexerTest } from '../routes/indexers/adapter/indexer/test/post.ts';
import { indexerCreate } from '../routes/indexers/adapter/indexer/post.ts';
import { indexerUpdate } from '../routes/indexers/adapter/indexer/[id]/put.ts';
import { indexerDelete } from '../routes/indexers/adapter/indexer/[id]/delete.ts';
import { restoreGate } from '../system/restore.ts';
import { adapterAuth, compatRouter, unsupported } from './router.ts';
import type { AdapterOptions } from '../types.ts';
import type { IndexerApp } from '@ladarr/shared/enums';

// The Sonarr and Radarr API. The indexer manager pushes indexers here, and Seerr reads and adds titles.
export function adapter(app: IndexerApp, options: AdapterOptions) {
  const router = Router();
  router.use(adapterAuth(), express.json({ limit: '100kb' }));
  router.use(adapterHeaders(app));
  if (options.restorer) router.use(restoreGate(options.restorer));
  router.get('/system/status', indexerSystemStatus(app, { urlBase: options.urlBase ?? '' }));
  router.get('/indexer/schema', indexerSchemaGet(app));
  router.get('/indexer', indexerListGet(app));
  router.get('/indexer/:id', indexerGet(app));
  router.post('/indexer/test', indexerTest(app));
  router.post('/indexer', indexerCreate(app, { onChange: options.onChange }));
  router.put('/indexer/:id', indexerUpdate(app, { onChange: options.onChange }));
  router.delete('/indexer/:id', indexerDelete(app, { onChange: options.onChange }));
  router.use(compatRouter(app, { tmdb: options.tmdb, events: options.events, enqueue: options.enqueue, services: options.services }));
  router.use(unsupported);
  return router;
}
