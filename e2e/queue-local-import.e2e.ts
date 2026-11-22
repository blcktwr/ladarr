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

test('does not map local files without a torrent', async ({ page }) => {
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
  await expect(panel).toHaveAccessibleName('Show Name (2020)');
  const table = panel.getByRole('table', { name: 'Map episodes', exact: true });
  await expect(table.getByRole('columnheader')).toHaveText(['Episodes', 'Torrent', 'Matches']);
  await expect(table.getByRole('row')).toHaveCount(4);
  const matches = table.getByRole('combobox', { name: 'Matches' });
  await expect(matches).toHaveCount(3);
  for (const match of await matches.all()) {
    await expect(match).toHaveValue('');
    await expect(match).toBeEnabled();
  }
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  const apply = panel.getByRole('button', { name: 'Apply mapping', exact: true });
  await expect(panel.getByRole('combobox').filter({ hasText: 'Season 1' })).toBeVisible();
  await apply.click();
  const question = page.getByRole('dialog', { name: 'Does every episode in season 1 match the correct file?', exact: true });
  await question.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question).toBeHidden();
  await expect(panel).toBeVisible();
  expect(writes).toEqual([]);
  expect(await reason('tv:1:1x1')).toBe('file_unmapped');
  await apply.click();
  await question.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(question).toBeHidden();
  await expect(panel).toBeHidden();

  expect(writes).toEqual([]);
  expect(await reason('tv:1:1x1')).toBe('file_unmapped');
  expect((await stack.call('GET', '/library/tv:1/files')).body.files).toEqual([]);
  expect(await Promise.all(['tv:1:1x2', 'tv:1:1x3'].map(async (id) => (await stack.call('GET', `/queue/entries/${id}`)).body.entry))).toEqual(siblings);
  expect(stack.tracker.state.searches).toEqual([]);
  expect(stack.tracker.state.downloads).toEqual([]);
});
