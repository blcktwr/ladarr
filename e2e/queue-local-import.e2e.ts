import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000 });

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
  for (const id of ['tv:1:1x1', 'tv:1:1x2', 'tv:1:1x3']) {
    await expect.poll(() => reason(id), { timeout: 60_000 }).toBe('file_unmapped');
  }
  const siblings = await Promise.all(['tv:1:1x2', 'tv:1:1x3'].map(async (id) => (await stack.call('GET', `/queue/entries/${id}`)).body.entry));
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/queue')) writes.push(request.url());
  });

  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="group:tv:1:1"]').click();
  const main = page.getByRole('main');
  await expect(main.getByText('The title folder has a file that names no episode.')).toHaveCount(0);
  await page.locator('[data-row="season:tv:1|1"]').click();
  const episodes = main.getByRole('table', { name: 'Episodes of season 1' });
  await expect(episodes).toContainText('Stuck');
  await expect(episodes.getByText('The title folder has a file that names no episode.')).toHaveCount(0);

  await expect(episodes.getByRole('button', { name: /^(?!About the status )/ })).toHaveCount(0);
  const map = main.getByRole('button', { name: 'Map episodes', exact: true });
  await expect(map).toHaveCount(1);
  await map.click();
  const panel = page.getByRole('dialog');
  await expect(panel).toHaveAccessibleName(/Show Name.*Season 1/);
  const table = panel.getByRole('table', { name: 'Map episodes', exact: true });
  await expect(table.getByRole('columnheader')).toHaveText(['Episode']);
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('combobox')).toHaveCount(3);
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  const apply = panel.getByRole('button', { name: 'Apply mapping', exact: true });
  await expect(apply).toBeDisabled();
  await expect(panel.locator(':scope > :last-child > button', { hasText: 'Apply mapping' })).toBeVisible();
  await table.getByRole('combobox', { name: 'Show Name S01E01', exact: true }).click();
  await page.getByRole('option', { name: /Clip A\.mkv/ }).click();
  await expect(panel.getByRole('button', { name: 'Preview changes', exact: true })).toHaveCount(0);
  await expect(apply).toBeEnabled();
  expect(writes).toEqual([]);
  expect(await reason('tv:1:1x1')).toBe('file_unmapped');
  const path = '/api/queue/entries/tv:1:1x1/match';
  const [preview, applied] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === path && response.request().postDataJSON().preview === true),
    page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === path && response.request().postDataJSON().preview !== true),
    apply.click(),
  ]);
  const body = { source: 'library', file: 'Show Name (2020)/Season 01/Clip A.mkv', covers: [{ season: 1, number: 1 }], ids: ['tv:1:1x1'] };
  expect(preview.status()).toBe(200);
  expect(preview.request().postDataJSON()).toMatchObject({ ...body, preview: true });
  expect(applied.status()).toBe(200);
  expect(applied.request().postDataJSON()).toMatchObject({ ...body, version: (await preview.json()).version });
  await expect(panel).toBeHidden();

  // The episode that the user matched is in the library, and the file keeps the path of its folder.
  await expect.poll(() => reason('tv:1:1x1'), { timeout: 60_000 }).toBeUndefined();
  const file = await stack.call('GET', '/library/tv:1/files');
  expect(file.body.files.map((item: { path: string }) => item.path)).toContain('Show Name (2020)/Season 01/Clip A.mkv');
  expect(await Promise.all(['tv:1:1x2', 'tv:1:1x3'].map(async (id) => (await stack.call('GET', `/queue/entries/${id}`)).body.entry))).toEqual(siblings);
  expect(stack.tracker.state.searches).toEqual([]);
  expect(stack.tracker.state.downloads).toEqual([]);
});
