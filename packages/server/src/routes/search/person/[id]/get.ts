import { db } from '../../../../core/db.ts';
import type { PersonCredits } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../../metadata/tmdb.ts';
import { inLibrary } from '../../../../helpers/search.ts';

export function searchPerson(tmdb: Tmdb | undefined): RequestHandler<{ id: string }> {
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    if (!/^[1-9]\d*$/.test(req.params.id!)) return void res.status(404).json({ error: 'not_found' });
    const { person, credits } = await tmdb.person(Number(req.params.id));
    res.json({ person, credits: inLibrary()(credits) } satisfies PersonCredits);
  };
}
