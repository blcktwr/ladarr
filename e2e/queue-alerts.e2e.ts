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

test('attaches the download that is in the client to the season', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="season:tv:1|1"]').click();
  const episodes = page.getByRole('table', { name: 'Episodes of season 1' });
  const row = episodes.locator('[data-row="entry:tv:1:1x1"]');
  await expect(episodes.getByRole('button', { name: /^(?!About the status )/ })).toHaveCount(0);
  const attach = page.getByRole('main').getByRole('button', { name: 'Attach download', exact: true });
  const path = '/api/queue/entries/tv:1:1x1/attach';
  const requests: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === path) requests.push(request.postDataJSON());
  });
  await expect(attach).toBeVisible();
  await attach.click();
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  const save = modal.getByRole('button', { name: 'Save', exact: true });
  const cancel = modal.getByRole('button', { name: 'Cancel', exact: true });
  await expect(save).toBeDisabled();
  await expect(cancel).toBeVisible();
  await expect(modal.getByRole('searchbox')).toHaveCount(0);
  await expect(modal.getByRole('checkbox')).toHaveCount(0);
  await expect(modal.getByRole('button', { name: 'Preview attachment', exact: true })).toHaveCount(0);
  const box = (await modal.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(2);
  const cancelBox = (await cancel.boundingBox())!;
  const saveBox = (await save.boundingBox())!;
  expect(cancelBox.x + cancelBox.width).toBeLessThanOrEqual(saveBox.x);
  // The torrent of the client is the one that stopped the episode. The option shows its size and progress too.
  await modal.getByRole('combobox', { name: 'Download' }).click();
  await page.getByRole('option', { name: new RegExp(SERIES_PACK) }).click();
  await expect(save).toBeEnabled();
  await cancel.click();
  await expect(modal).toBeHidden();
  expect(requests).toEqual([]);
  expect((await stack.call('GET', '/queue/groups/tv:1')).body.items.every((item: { status: string }) => item.status === 'stuck')).toBe(true);
  await attach.click();
  await expect(save).toBeDisabled();
  await modal.getByRole('combobox', { name: 'Download' }).click();
  await page.getByRole('option', { name: new RegExp(SERIES_PACK) }).click();
  const [preview, applied] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === path && response.request().postDataJSON().preview === true),
    page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === path && response.request().postDataJSON().preview !== true),
    save.click(),
  ]);
  expect(preview.status()).toBe(200);
  expect((await preview.json()).affected.map((item: { id: string }) => item.id)).toEqual(['tv:1:1x1', 'tv:1:1x2', 'tv:1:1x3']);
  expect(applied.status()).toBe(200);
  expect(applied.request().postDataJSON()).toMatchObject({ hash, ids: ['tv:1:1x2', 'tv:1:1x3'], confirmOwner: true, confirmTitle: true, version: (await preview.json()).version });
  await expect(modal).toBeHidden();
  // The target downloads the torrent of the client now.
  await expect(row).toContainText('Downloading');
  // The entry holds the hash of the torrent, and the reason that stopped it is gone.
  await expect
    .poll(
      async () => {
        const item = (await stack.call('GET', '/queue/groups/tv:1')).body.items.find((entry: { number?: number }) => entry.number === 1);
        return { hash: item?.transfer?.hash ?? null, reason: item?.reason?.code ?? null };
      },
      { timeout: 60_000 },
    )
    .toEqual({ hash, reason: null });
  const siblings = (await stack.call('GET', '/queue/groups/tv:1')).body.items.filter((item: { number: number }) => item.number !== 1);
  expect(siblings.map((item: { status: string }) => item.status)).toEqual(['downloading', 'downloading']);
});
