import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';
import { expect, test } from './fixtures.ts';
import { configure, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const DEST = 'Show Name (2020)/Season 01/Show Name - S01E01 - Episode 1.mkv';
const FILES = [1, 2, 3].map((number) => `Show.Name.S01E0${number}.mkv`);
const entry = () => stack.call('GET', '/queue/entries/tv:1:1x1').then((res) => res.body.entry);

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  stack.tracker.state.items = [{ title: SERIES_PACK, size: 3 * 60 * 45 * 1024 * 1024, files: FILES }];
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('offers the destination fix without a generic retry of the season', async ({ page }) => {
  await expect.poll(() => stack.qbit.torrents.size, { timeout: 60_000 }).toBe(1);

  // The destination name of the first episode holds a file that the library does not know, so that episode stops.
  const dest = join(stack.folders.tv, DEST);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, 'someone else');
  stack.complete(SERIES_PACK, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'Show.Name.S01E03.mkv': 'three' }, hashOf(SERIES_PACK, FILES));
  await expect.poll(async () => (await entry())?.reason?.code, { timeout: 60_000 }).toBe('destination_exists');

  await page.goto(`${URL_BASE}/activity`);
  // The card of the season shows the reason of the episode that stopped, and the fix that ends it. The checklist belongs
  // to the importing indicator, so a stuck season does not show it.
  const main = page.getByRole('main');
  await expect(main.getByText('A file with this name is in the library folder already. It is not replaced.')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Replace file', exact: true })).toBeVisible();
  await expect(main.getByText('The download is complete.')).toBeHidden();

  await page.getByRole('button', { name: 'Actions for Show Name (2020) Season 1' }).click();
  await expect(page.getByRole('menuitem', { name: 'Try again', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect((await entry())?.status).toBe('stuck');
});
