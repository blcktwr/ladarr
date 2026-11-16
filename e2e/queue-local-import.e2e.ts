import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const reason = (id: string) => stack.call('GET', `/queue/entries/${id}`).then((res) => res.body.entry?.reason?.code);

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The series is on the disk already. Its files name no episode, so none of them is imported on its own.
  const folder = join(stack.folders.tv, 'Show Name (2020)', 'Season 01');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'Clip A.mkv'), 'episode-one');
  writeFileSync(join(folder, 'Clip B.mkv'), 'episode-two');
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('stops the season on its own files instead of a download', async () => {
  // The folder is read before the indexers, so the season waits for the user and nothing reaches the tracker.
  await expect.poll(() => reason('tv:1:1x1'), { timeout: 60_000 }).toBe('file_unmapped');
  expect(stack.tracker.state.searches).toEqual([]);
  expect(stack.tracker.state.downloads).toEqual([]);
});

test('offers the file of the folder and maps the episode with it', async ({ page }) => {
  await expect.poll(() => reason('tv:1:1x1'), { timeout: 60_000 }).toBe('file_unmapped');

  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="group:tv:1:1"]').click();
  const main = page.getByRole('main');
  // The card says why the season waits, and the episodes of the folder keep their stuck state.
  await expect(main.getByText('The title folder has a file that names no episode.')).toBeVisible();
  await page.locator('[data-row="season:tv:1|1"]').click();
  const episodes = main.getByRole('table', { name: 'Episodes of season 1' });
  await expect(episodes).toContainText('Stuck');

  // The row of an episode that the folder holds offers the match of its file.
  await episodes.locator('[data-row="entry:tv:1:1x1"]').getByRole('button', { name: 'Match file' }).click();
  const panel = page.getByRole('dialog', { name: /Match file to/ });
  await panel.getByRole('combobox', { name: 'File' }).click();
  await page.getByRole('option', { name: /Clip A\.mkv/ }).click();
  await panel.getByRole('button', { name: 'Show the changes' }).click();
  await panel.getByRole('button', { name: 'Use this file' }).click();

  // The episode that the user matched is in the library, and the file keeps the path of its folder.
  await expect.poll(() => reason('tv:1:1x1'), { timeout: 60_000 }).toBeUndefined();
  const file = await stack.call('GET', '/library/tv:1/files');
  expect(file.body.files.map((item: { path: string }) => item.path)).toContain('Show Name (2020)/Season 01/Clip A.mkv');
});
