import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Data } from '../packages/server/src/types.ts';
import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE } from './stack.ts';

for (const mediaType of ['movie', 'tv'] as const) {
  test(`the quality badge shows only files of that quality on a ${mediaType} title`, async ({ page, context }) => {
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
      const sources = series ? ['WEB-DL', 'WEB-DL', 'BluRay'] : ['WEB-DL', null];
      for (const [index, qualitySource] of sources.entries()) {
        const number = index + 1;
        const path = `Library.File.${number}.1080p${qualitySource ? `.${qualitySource}` : ''}.mkv`;
        const abs = join(series ? stack.folders.tv : stack.folders.movies, path);
        writeFileSync(abs, 'video');
        const { size, mtimeMs } = statSync(abs);
        data.files[path] = {
          id: path, titleKey: key, path, sizeBytes: size, mtimeMs, addedAt: Date.now(), missing: false,
          episodes: series ? [{ season: 1, number }] : [], download: number === 1 ? source : null,
        };
        if (series) title.episodes.find((e) => e.season === 1 && e.number === number)!.fileId = path;
        else if (number === 1) title.fileId = path;
      }
      writeFileSync(database, JSON.stringify(data));
      await stack.server.start();

      await page.goto(`${URL_BASE}/catalog/${mediaType}/${id}`);
      const web = page.getByRole('button', { name: 'Show details of WEB-DL 1080p', exact: true });
      const otherQuality = series ? 'BluRay 1080p' : '1080p';
      const other = page.getByRole('button', { name: `Show details of ${otherQuality}`, exact: true });
      await expect(web).toHaveText('WEB-DL 1080p');
      await expect(other).toHaveText(otherQuality);
      await expect(page.getByRole('button', { name: /^Show details of / })).toHaveCount(2);

      await web.click();
      const dialog = page.getByRole('dialog', { name: 'Downloaded file 1080p', exact: true });
      const file = dialog.getByRole('tab', { name: 'File', exact: true });
      const torrent = dialog.getByRole('tab', { name: 'Torrent', exact: true });
      const picker = dialog.getByRole('combobox', { name: 'File', exact: true });
      await expect(file).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.getByRole('tabpanel', { name: 'File' })).toContainText('matroska,webm');
      if (!series) await expect(picker).toHaveCount(0);
      await torrent.click();
      const panel = dialog.getByRole('tabpanel', { name: 'Torrent' });
      for (const field of [source.name, source.hash, source.file]) await expect(panel.getByText(field, { exact: true })).toBeVisible();

      if (series) {
        await file.click();
        await picker.click();
        await expect(page.getByRole('option')).toHaveCount(2);
        await expect(page.getByRole('option', { name: 'S01E01', exact: true })).toBeVisible();
        await page.getByRole('option', { name: 'S01E02', exact: true }).click();
        await torrent.click();
        await expect(panel).not.toContainText(source.hash);
        await expect(panel).toContainText(/no .*torrent|torrent.*not |no .*download/i);
      }

      await dialog.getByText('Close', { exact: true }).click();
      await other.click();
      await expect(dialog.getByRole('tabpanel', { name: 'File' })).toContainText('matroska,webm');
      await expect(picker).toHaveCount(0);
      await torrent.click();
      await expect(panel).not.toContainText(source.hash);
      await expect(panel).toContainText(/no .*torrent|torrent.*not |no .*download/i);
    } finally {
      await stack.stop();
    }
  });
}
