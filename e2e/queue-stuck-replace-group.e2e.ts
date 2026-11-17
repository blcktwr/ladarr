import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';
import { expect, test } from './fixtures.ts';
import { configure, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000 });

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const DEST = (number: number) => `Show Name (2020)/Season 01/Show Name - S01E0${number} - Episode ${number}.mkv`;
const FILES = [1, 2, 3].map((number) => `Show.Name.S01E0${number}.mkv`);
const entry = (number: number) => stack.call('GET', `/queue/entries/tv:1:1x${number}`).then((res) => res.body.entry);

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

test('replaces the files of every episode that stopped on a taken destination name', async ({ page }) => {
  await expect.poll(() => stack.qbit.torrents.size, { timeout: 60_000 }).toBe(1);

  // Two episodes of the pack find a file at their destination that the library does not know, so both stop.
  for (const number of [1, 2]) {
    const dest = join(stack.folders.tv, DEST(number));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, 'someone else');
  }
  stack.complete(SERIES_PACK, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'Show.Name.S01E03.mkv': 'three' }, hashOf(SERIES_PACK, FILES));
  await expect
    .poll(
      async () => {
        const codes = await Promise.all([1, 2].map(async (number) => (await entry(number))?.reason?.code ?? null));
        return codes.every((code) => code === 'destination_exists');
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // The row of the season offers one replacement for the two files that it stopped on.
  await page.goto(`${URL_BASE}/activity`);
  const replace = page.getByRole('button', { name: 'Replace file', exact: true });
  await expect(replace).toHaveCount(1);
  await replace.click();
  const ask = page.getByRole('dialog', { name: 'Replace the file?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Replace', exact: true }).click();

  // The preview names both episodes before the files change.
  const preview = page.getByRole('dialog', { name: 'Replace 2 targets?' });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Show Name S01E01');
  await expect(preview).toContainText('Show Name S01E02');
  await preview.getByRole('button', { name: 'Replace', exact: true }).click();

  await expect.poll(async () => (await entry(1))?.status, { timeout: 60_000 }).toBe('available');
  await expect.poll(async () => (await entry(2))?.status, { timeout: 60_000 }).toBe('available');
  expect(readFileSync(join(stack.folders.tv, DEST(1)), 'utf8')).toBe('one');
  expect(readFileSync(join(stack.folders.tv, DEST(2)), 'utf8')).toBe('two');
});
