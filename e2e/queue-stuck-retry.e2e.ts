import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { configure, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const DEST = 'Show Name (2020)/Season 01/Show Name - S01E01 - Episode 1.mkv';
const entry = () => stack.call('GET', '/queue/entries/tv:1:1x1').then((res) => res.body.entry);

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('starts the episodes of a series that stopped again from the menu of the series', async ({ page }) => {
  await expect.poll(() => stack.qbit.torrents.size, { timeout: 60_000 }).toBe(1);

  // The destination name of the first episode holds a file that the library does not know, so that episode stops.
  const dest = join(stack.folders.tv, DEST);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, 'someone else');
  stack.complete(SERIES_PACK, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'Show.Name.S01E03.mkv': 'three' });
  await expect.poll(async () => (await entry())?.reason?.code, { timeout: 60_000 }).toBe('destination_exists');

  // The row of the series offers the retry of its stopped episodes. The action shows what it changes first.
  await page.goto(`${URL_BASE}/activity`);
  await page.getByRole('button', { name: 'Actions for Show Name (2020) Season 1' }).click();
  await page.getByRole('menuitem', { name: 'Try again', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Try again 1 target?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Show Name S01E01');

  // The import runs again, so the file that held the destination name goes before the retry.
  rmSync(dest);
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.poll(async () => (await entry())?.stage, { timeout: 60_000 }).toBe('available');
});
