import { db } from '../../../../core/db.ts';
import type { MediaType } from '@ladarr/shared/enums';
import type { SourceFolder } from '@ladarr/shared/types';
import { basename } from 'node:path';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../../metadata/tmdb.ts';
import { biggestFirst, MAX_FILES, titleFromFile } from '../../../../library/imports/source.ts';
import { guessTitle } from '../../../../library/tools/folders.ts';
import { PlanError } from '../../../../library/imports/plan.ts';
import { readFolder } from '../../../../library/imports/manual.ts';
import { parseEpisodes } from '../../../../library/parse.ts';
import { fail } from '../../../../helpers/import-source.ts';

// The folder, the title that its name suggests, and the TMDB results of that name.
export function importSourceDetect({ tmdb, configDir }: { tmdb?: Tmdb; configDir?: string } = {}): RequestHandler {
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    try {
      const { path } = req.body ?? {};
      const { real, videos } = await readFolder({ path, configDir });
      if (!videos.length) throw new PlanError('nothing_to_import');
      const mediaType: MediaType = videos.some((file) => parseEpisodes(basename(file.rel))) ? 'tv' : 'movie';

      // The folder name first. The name of its biggest file comes second, because a download folder often has the
      // name of the download ("inbox") and not the name of the title.
      let guess = guessTitle(basename(real));
      let results = await tmdb.search(guess.title);
      if (!results.length) {
        const file = titleFromFile(biggestFirst(videos)[0]!.rel);
        const found = file ? await tmdb.search(file.title) : [];
        if (file && found.length) {
          guess = file;
          results = found;
        }
      }
      const folder: SourceFolder = {
        path: real,
        mediaType,
        guess,
        videoFiles: videos.length,
        sizeBytes: videos.reduce((sum, file) => sum + file.sizeBytes, 0),
        truncated: videos.length >= MAX_FILES,
        results: [...results.filter((result) => result.mediaType === mediaType), ...results.filter((result) => result.mediaType !== mediaType)],
      };
      res.json({ folder });
    } catch (error) {
      fail(res, error);
    }
  };
}
