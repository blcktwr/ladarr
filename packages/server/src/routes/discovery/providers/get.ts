import type { WatchProvider } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../metadata/tmdb.ts';

// The code of a country in ISO 3166-1.
const REGION = /^[A-Z]{2}$/;

// The watch providers of a country. A service that streams movies or series of the country shows once, at the higher
// place of the two lists.
export function discoveryProvidersGet(tmdb: Tmdb | undefined): RequestHandler {
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const region = typeof req.query.region === 'string' ? req.query.region.toUpperCase() : '';
    if (!REGION.test(region)) return void res.status(400).json({ error: 'invalid_region' });
    const [movies, series] = await Promise.all([tmdb.watchProviders('movie', region), tmdb.watchProviders('tv', region)]);
    const known = new Map<number, WatchProvider & { priority: number }>();
    for (const provider of [...movies, ...series]) {
      const found = known.get(provider.id);
      if (!found || provider.priority < found.priority) known.set(provider.id, provider);
    }
    const providers: WatchProvider[] = [...known.values()]
      .sort((a, b) => a.priority - b.priority)
      .map(({ id, name, logoPath }) => ({ id, name, logoPath }));
    res.json(providers);
  };
}
