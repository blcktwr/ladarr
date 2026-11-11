import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { configure, MOVIE_RELEASE, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const entry = () => stack.call('GET', '/queue/entries/movie:2').then((res) => res.body.entry);

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  const added = await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('replaces the file that holds the destination name when the user asks', async ({ page }) => {
  await expect.poll(async () => (await entry())?.stage, { timeout: 60_000 }).toBe('downloading');

  const folder = join(stack.folders.movies, 'Movie Name (2019)');
  const file = join(folder, 'Movie Name (2019).mkv');
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, 'someone else');
  stack.complete(MOVIE_RELEASE, { [`${MOVIE_RELEASE}.mkv`]: 'video-data' });
  await expect.poll(async () => (await entry())?.reason?.code, { timeout: 60_000 }).toBe('destination_exists');

  // A restart drops the checks that are in memory. The reason is enough to offer the fix.
  await stack.restart();

  // The stuck target offers the fix next to its indicator.
  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="entry:movie:2"]').click();
  await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await page.getByRole('button', { name: 'Replace the file', exact: true }).click();
  await page.getByRole('button', { name: 'Replace', exact: true }).click();

  await expect.poll(async () => (await entry())?.stage, { timeout: 60_000 }).toBe('available');
  expect(readFileSync(file, 'utf8')).toBe('video-data');
});
