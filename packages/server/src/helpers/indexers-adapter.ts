import type { RequestHandler } from 'express';
import {
  IMPLEMENTATIONS,
  MASK,
  SCHEMA_FIELDS,
  invalid,
  parsePush,
  savePush,
  type Indexer,
  type IndexerApp,
} from '../library/grab/indexers.ts';
import { type Db, db } from '../core/db.ts';

// The version that ladarr reports to the indexer manager. The indexer manager needs 3.0.5.0 or later.
export const VERSION: Record<IndexerApp, string> = { sonarr: '4.0.0.0', radarr: '5.0.0.0' };

export function adapterHeaders(app: IndexerApp): RequestHandler {
  return (_req, res, next) => {
    res.set({ 'X-Application-Version': VERSION[app], 'Cache-Control': 'no-store' });
    next();
  };
}

type Resource = Record<string, unknown>;

// The values of the indexer for one app, in the shape of a Sonarr or Radarr indexer.
export function resource(app: IndexerApp, indexer: Indexer): Resource {
  const push = indexer.push[app]!;
  const implementation = indexer.protocol === 'usenet' ? 'Newznab' : 'Torznab';
  const value = (name: string, fallback: unknown) => {
    if (name === 'baseUrl') return indexer.baseUrl;
    if (name === 'apiPath') return indexer.apiPath;
    if (name === 'apiKey') return MASK;
    if (name === 'categories') return push.categories;
    if (name === 'animeCategories') return push.animeCategories;
    if (name === 'minimumSeeders') return push.minimumSeeders;
    return name in push.fields ? push.fields[name] : fallback;
  };
  return {
    id: indexer.id,
    name: push.name,
    fields: SCHEMA_FIELDS[app].map(({ default: fallback, ...rest }) => ({ ...rest, value: value(rest.name, fallback) })),
    implementationName: implementation,
    implementation,
    configContract: `${implementation}Settings`,
    infoLink: '',
    tags: push.tags,
    enableRss: push.enableRss,
    enableAutomaticSearch: push.enableAutomaticSearch,
    enableInteractiveSearch: push.enableInteractiveSearch,
    supportsRss: true,
    supportsSearch: true,
    protocol: indexer.protocol ?? 'torrent',
    priority: push.priority,
    seasonSearchMaximumSingleEpisodeAge: 0,
    downloadClientId: push.downloadClientId ?? 0,
  };
}

export const schemaResource = (app: IndexerApp, implementation: (typeof IMPLEMENTATIONS)[number]): Resource => ({
  id: 0,
  name: '',
  fields: SCHEMA_FIELDS[app].map(({ default: value, ...rest }) => ({ ...rest, value })),
  implementationName: implementation,
  implementation,
  configContract: `${implementation}Settings`,
  infoLink: '',
  tags: [],
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  supportsRss: true,
  supportsSearch: true,
  protocol: implementation === 'Torznab' ? 'torrent' : 'usenet',
  priority: 25,
  seasonSearchMaximumSingleEpisodeAge: 0,
  downloadClientId: 0,
});

// The POST and the PUT of an indexer share this handler. The PUT names the record in the path.
export function save(app: IndexerApp, { onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler<{ id?: string }> {
  return async (req, res) => {
    const parsed = parsePush(app, req.body);
    if ('errors' in parsed) return void res.status(400).json(parsed.errors);
    const id = req.params.id === undefined ? undefined : Number(req.params.id);
    const indexer = savePush(app, parsed, id);
    if (!indexer) {
      if (id !== undefined && !db.data.indexers[id]?.push[app]) return void res.status(404).json({ message: 'NotFound' });
      return void res.status(400).json(invalid('apiKey', 'The API key is missing.').errors);
    }
    await db.write();
    onChange();
    res.json(resource(app, indexer));
  };
}
