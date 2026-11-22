import { expect, test } from './fixtures.ts';
import { configure, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';
import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const files = [1, 2, 3].map((number) => `Show.Name.S01E0${number}.mkv`);
const hash = hashOf(SERIES_PACK, files);
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  stack.tracker.state.items.find((item) => item.title === SERIES_PACK)!.files = files;
  // The manual torrent arrives after the initial client lookup, but before the release reaches the client.
  stack.tracker.state.answer = (url) => {
    if (url.searchParams.get('t') === 'tvsearch' && !stack.qbit.torrents.has(hash)) {
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
      stack.qbit.setFiles(hash, files.map((name) => ({ name: `${SERIES_PACK}/${name}`, size: 1000, progress: 0.2 })));
    }
    return stack.tracker.state.items;
  };
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
  // The three episodes of the pack stop on the reason before the page opens.
  await expect
    .poll(
      async () => {
        const items = (await stack.call('GET', '/queue/groups/tv:1')).body.items as { status: string; reason: { code: string } | null }[];
        return items.length === 3 && items.every((item) => item.status === 'stuck' && item.reason?.code === 'torrent_exists');
      },
      { timeout: 60_000 },
    )
    .toBe(true);
});
test.afterAll(() => stack.stop());

test('shows the status on the series and on each episode in the catalog', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  // The tile of the series in the catalog holds the status of its episodes.
  await page.goto(`${URL_BASE}/catalog`);
  await expect(page.locator('a[href$="/catalog/tv/1"]')).toContainText('Stuck');
  await page.goto(`${URL_BASE}/catalog/tv/1`);
  await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
  // Each row of the table holds the status of its episode.
  const table = page.getByRole('table', { name: /Episodes/ });
  await expect(table.getByText('Stuck', { exact: true })).toHaveCount(3);
});

test('shows the status on the series and on each episode', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/activity`);
  // The row of the series holds the status of its episodes.
  await expect(page.locator('[data-row="group:tv:1:1"]')).toContainText('Stuck');
  // A click on the row of the season opens its episodes under the table, and a second click closes them.
  const season = page.locator('[data-row="season:tv:1|1"]');
  await season.click();
  await expect(page.getByRole('table', { name: 'Episodes of season 1' })).toBeVisible();
  await season.click();
  await expect(page.getByRole('table', { name: 'Episodes of season 1' })).toBeHidden();
  await season.click();
  // An episode shows its own status too.
  await expect(page.locator('[data-row="entry:tv:1:1x1"]')).toContainText('Stuck');
});

test('keeps the reason in the status indicator instead of the episode row', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="season:tv:1|1"]').click();
  const episodes = page.getByRole('table', { name: 'Episodes of season 1' });
  await expect(episodes).toBeVisible();
  const reason = 'This torrent is in the client already and was not added by the app.';
  await expect(episodes.getByText(reason)).toHaveCount(0);
  await expect(episodes.locator('[data-row="entry:tv:1:1x1"]').getByRole('button', { name: 'About the status Stuck', exact: true })).toHaveAccessibleDescription(reason);
});
