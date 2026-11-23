import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { hashOf, makeTorrent } from '../packages/server/tests/helpers/test-pipeline.ts';
import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE } from './stack.ts';

test.use({ actionTimeout: 15_000 });

async function openUpload(page: Page) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Upload torrent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload torrent' });
  await expect(dialog.getByLabel('Torrent file', { exact: true })).toBeVisible();
  return dialog;
}

const input = (buffer: Buffer) => ({ name: 'chosen.torrent', mimeType: 'application/x-bittorrent', buffer });

test('reviews folder mapping before download and keeps the accepted file and original torrent across a restart', async ({ page, context }) => {
  test.setTimeout(150_000);
  const stack = await startStack();
  try {
    const cookie = await stack.createOwner();
    await context.addCookies([{ ...cookie, url: URL_BASE }]);
    await configure(stack);
    const client = (await stack.call('GET', '/clients')).body.clients[0];
    expect((await stack.call('PUT', `/clients/${client.id}`, { ...client, auth: { type: 'password', username: 'admin' }, maxDownloads: 1 })).status).toBe(200);
    await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'paused' });
    await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'future' });
    await expect.poll(async () => (await stack.call('GET', '/library/tv:1/episodes?season=1')).body.episodes?.length).toBe(3);

    await page.goto(`${URL_BASE}/catalog/movie/2`);
    const submissions: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/torrent')) submissions.push(r.url()); });
    const movieDialog = await openUpload(page);
    await expect(movieDialog.getByRole('combobox', { name: 'Mapping method' })).toHaveCount(0);
    await movieDialog.getByRole('button', { name: 'Cancel' }).click();
    expect(submissions).toHaveLength(0);
    const movie = 'Movie upload';
    const movieFile = ['Feature.mkv'];
    const movieHash = hashOf(movie, movieFile);
    await openUpload(page);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      movieDialog.getByLabel('Torrent file', { exact: true }).click(),
    ]);
    await chooser.setFiles(input(makeTorrent(movie, movieFile)));
    expect(submissions).toHaveLength(0);
    await movieDialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect.poll(() => stack.qbit.torrents.has(movieHash)).toBe(true);
    expect(submissions).toHaveLength(1);

    const pack = 'Release folders';
    const paths = ['Season 1/1.mkv', 'Season 2/1.mkv'];
    const bytes = makeTorrent(pack, paths, 'Keep the complete torrent file across the restart.');
    const hash = hashOf(pack, paths);
    await page.goto(`${URL_BASE}/catalog/tv/1`);
    const dialog = page.getByRole('dialog', { name: 'Upload torrent' });
    const chooseFolders = async () => {
      await openUpload(page);
      const before = submissions.length;
      const method = dialog.getByRole('combobox', { name: 'Mapping method' });
      await expect(method).toContainText('Default');
      await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
      await method.click();
      await page.getByRole('option', { name: 'Numeric bulk mapping by folder' }).click();
      expect(submissions).toHaveLength(before);
      const transfer = await page.evaluateHandle((data) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(data)], 'chosen.torrent'));
        return transfer;
      }, [...bytes]);
      const field = dialog.getByLabel('Torrent file', { exact: true });
      await field.dispatchEvent('dragover', { dataTransfer: transfer });
      await field.dispatchEvent('drop', { dataTransfer: transfer });
      await transfer.dispose();
      await expect(dialog.getByRole('combobox', { name: /Season 2\/1\.mkv/ })).toHaveValue(/S01E02.*Episode 2/i);
      await expect(dialog.getByText('chosen.torrent', { exact: true })).toBeVisible();
    };
    await chooseFolders();
    await dialog.getByRole('combobox', { name: 'Mapping method' }).click();
    await page.getByRole('option', { name: 'Default', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: /Season 2\/1\.mkv/ })).toHaveValue('Unassigned');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(stack.qbit.torrents.size).toBe(1);
    expect((await stack.call('GET', '/queue/entries/tv:1:1x1')).status).toBe(404);

    await chooseFolders();
    await dialog.getByRole('combobox', { name: /Season 2\/1\.mkv/ }).click();
    await page.getByRole('option', { name: /S01E02.*Episode 2/i }).click();
    await page.getByRole('option', { name: /S01E03.*Episode 3/i }).click();
    await page.keyboard.press('Escape');
    const apply = dialog.getByRole('button', { name: 'Import', exact: true });
    await page.route('**/api/library/tv:1/torrent/apply', (route) => route.fulfill({ status: 502, json: { error: 'client_unreachable' } }), { times: 1 });
    await apply.click();
    await expect(dialog.getByText('The download client does not answer.', { exact: true })).toBeVisible();
    await apply.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await stack.call('GET', '/queue/entries/tv:1:1x3')).body.entry?.phase).toBe('waiting_slot');
    expect(stack.qbit.torrents.has(hash)).toBe(false);
    await stack.restart();
    stack.complete(movie, { 'Feature.mkv': 'M'.repeat(1000) }, movieHash);
    await expect.poll(() => stack.qbit.torrents.has(hash), { timeout: 40_000 }).toBe(true);
    expect(stack.qbit.receivedTorrents.filter((file) => file.equals(bytes))).toHaveLength(1);
    stack.complete(pack, { [paths[0]!]: 'A'.repeat(1000), [paths[1]!]: 'C'.repeat(1000) }, hash);
    const libraryFiles = async () => (await stack.call('GET', '/library/tv:1/files')).body.files as { path: string; episodes: { number: number }[] }[];
    await expect.poll(async () => (await libraryFiles()).length, { timeout: 40_000 }).toBe(2);
    const files = await libraryFiles();
    expect(files.flatMap((f) => f.episodes.map((e) => e.number)).sort()).toEqual([1, 3]);
    expect(readFileSync(join(stack.folders.tv, files.find((f) => f.episodes[0]?.number === 3)!.path), 'utf8')).toBe('C'.repeat(1000));
    expect(stack.tracker.state.searches).toEqual([]);
    expect(stack.tracker.state.downloads).toEqual([]);
  } finally {
    await stack.stop();
  }
});
