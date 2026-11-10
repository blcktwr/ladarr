import { expect, test } from './fixtures.ts';
import { configure, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';
import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The user added the pack in the client before the app found the release, so the grab stops for each episode.
  const hash = hashOf(SERIES_PACK);
  stack.qbit.torrents.set(hash, {
    hash,
    name: SERIES_PACK,
    size: 1_000_000,
    progress: 0.2,
    state: 'downloading',
    category: 'manual',
    tags: '',
    save_path: stack.folders.downloads,
    content_path: `${stack.folders.downloads}/${SERIES_PACK}`,
    dlspeed: 1000,
    eta: 100,
    num_seeds: 1,
    num_leechs: 1,
    added_on: Math.floor(Date.now() / 1000),
  });
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
  // The three episodes of the pack stop on the reason before the page opens.
  await expect
    .poll(
      async () => {
        const items = (await stack.call('GET', '/queue/groups/tv:1')).body.items as { reason: unknown; branch: unknown }[];
        return items.length === 3 && items.every((item) => item.reason && !item.branch);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
});
test.afterAll(() => stack.stop());

test('shows the status on the series and on each episode in the catalog', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/catalog/tv/1`);
  // The header holds the status of the series.
  await expect(page.getByText('Sending', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
  // Each row of the table holds the status of its episode.
  const table = page.getByRole('table', { name: /Episodes/ });
  await expect(table.getByText('Sending', { exact: true })).toHaveCount(3);
});

test('shows the status on the series and on each episode', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/activity`);
  // The row of the series holds the status of its episodes.
  await expect(page.locator('[data-row="group:tv:1"]')).toContainText('Sending');
  // A click on the row of the season opens its episodes under the table, and a second click closes them.
  const season = page.locator('[data-row="season:tv:1|1"]');
  await season.click();
  await expect(page.getByRole('table', { name: 'Episodes of season 1' })).toBeVisible();
  await season.click();
  await expect(page.getByRole('table', { name: 'Episodes of season 1' })).toBeHidden();
  await season.click();
  // An episode shows its own status too.
  await expect(page.locator('[data-row="entry:tv:1:1x1"]')).toContainText('Sending');
});

test('shows the reason that stops an episode under its row', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="season:tv:1|1"]').click();
  const episodes = page.getByRole('table', { name: 'Episodes of season 1' });
  await expect(episodes).toBeVisible();
  // The reason shows in the row, where the file name shows during validation.
  await expect(episodes.getByText('This torrent is in the client already and was not added by the app. You can attach it to this target.')).toHaveCount(3);
});
