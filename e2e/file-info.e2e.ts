import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Data } from '../packages/server/src/types.ts';
import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE } from './stack.ts';

for (const mediaType of ['movie', 'tv'] as const) {
  test(`the quality badge shows the selected file and its torrent on a ${mediaType} title`, async ({ page, context }) => {
    const stack = await startStack();
    try {
      const cookie = await stack.createOwner();
      await context.addCookies([{ ...cookie, url: URL_BASE }]);
      await configure(stack, { client: false });
      const series = mediaType === 'tv';
      const id = series ? 1 : 2;
      const key = `${mediaType}:${id}`;
      const added = await stack.call('POST', '/library', { mediaType, tmdbId: id, add: 'paused' });
      expect(added.status).toBe(201);
      if (series) await expect.poll(async () => (await stack.call('GET', `/library/${key}/episodes?season=1`)).body.episodes?.length).toBe(3);
      await stack.server.stop();
      const database = join(stack.folders.config, 'db.json');
      const data: Data = JSON.parse(readFileSync(database, 'utf8'));
      const title = data.titles[key]!;
      const source = { name: 'Original.Release.1080p', file: 'release/feature.mkv', hash: 'a'.repeat(40), clientId: 'retired', external: false };
      for (const number of series ? [1, 2] : [1]) {
        const path = `Library.File.${number}.1080p.mkv`;
        const abs = join(series ? stack.folders.tv : stack.folders.movies, path);
        writeFileSync(abs, 'video');
        const { size, mtimeMs } = statSync(abs);
        data.files[path] = {
          id: path, titleKey: key, path, sizeBytes: size, mtimeMs, addedAt: Date.now(), missing: false,
          episodes: series ? [{ season: 1, number }] : [], download: number === 1 ? source : null,
        };
        if (series) title.episodes.find((e) => e.season === 1 && e.number === number)!.fileId = path;
        else title.fileId = path;
      }
      writeFileSync(database, JSON.stringify(data));
      await stack.server.start();

      await page.goto(`${URL_BASE}/catalog/${mediaType}/${id}`);
      await page.getByRole('button', { name: 'Show details of 1080p' }).click();
      const dialog = page.getByRole('dialog', { name: 'Downloaded file 1080p' });
      const file = dialog.getByRole('tab', { name: 'File', exact: true });
      const torrent = dialog.getByRole('tab', { name: 'Torrent', exact: true });
      await expect(file).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.getByRole('tabpanel', { name: 'File' })).toContainText('matroska,webm');
      await torrent.click();
      const panel = dialog.getByRole('tabpanel', { name: 'Torrent' });
      for (const field of [source.name, source.hash, source.file]) await expect(panel.getByText(field, { exact: true })).toBeVisible();

      if (series) {
        await file.click();
        await dialog.getByRole('combobox', { name: 'File' }).click();
        await page.getByRole('option', { name: 'S01E02' }).click();
        await torrent.click();
        await expect(panel).not.toContainText(source.hash);
        await expect(panel).toContainText(/no .*torrent|torrent.*not |no .*download/i);
      }
    } finally {
      await stack.stop();
    }
  });
}
