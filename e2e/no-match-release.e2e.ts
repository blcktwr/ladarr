import { expect, test } from './fixtures.ts';
import { configure, MIB, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(90_000);

const LOW = Array.from({ length: 10 }, (_, index) => `Movie.Name.2019.720p.BluRay.x264-LOW${index}`);
const RELEASE = LOW.at(-1)!;
const TINY = 'Movie.Name.2019.1080p.WEB-DL-TINY';
const WRONG = 'Other.Movie.2019.1080p.BluRay-WRONG';
const CORRUPT = 'Movie.Name.2019.1080p.BluRay-CORRUPT';

let stack: Stack;
test.beforeEach(async ({ context }) => {
  stack = await startStack();
  const cookie = await stack.createOwner();
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await configure(stack);
});
test.afterEach(() => stack.stop());

test('keeps the ranked rejections in Stuck and verifies a manual choice beyond the first eight', async ({ page }) => {
  // A movie has no size limit by default. The TINY release must be rejected by its size again.
  const sizes = await stack.call('PUT', '/quality/sizes/movie/webdl-1080', { min: 12.5, preferred: null, max: null });
  if (sizes.status >= 300) throw new Error(`PUT /quality/sizes/movie/webdl-1080 answered ${sizes.status}: ${JSON.stringify(sizes.body)}`);
  stack.tracker.state.items = [
    { title: CORRUPT, size: 100 * 120 * MIB, bad: true, seeders: 100 },
    ...LOW.map((title, index) => ({ title, size: 60 * 100 * MIB, seeders: 40 - index })).reverse(),
    { title: TINY, size: 10 * MIB },
    { title: WRONG, size: 100 * 120 * MIB },
  ].map((item) => ({ ...item, category: 2040 }));
  const movie = await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' });
  if (movie.status >= 300) throw new Error(`POST /library answered ${movie.status}: ${JSON.stringify(movie.body)}`);

  await page.goto(`${URL_BASE}/activity`);
  const inspect = page.getByRole('button', { name: 'Inspect Movie Name (2019)' });
  const table = page.getByRole('table', { name: 'Rejected releases' });
  await expect(table).toBeVisible({ timeout: 60_000 });
  await page.getByRole('tab', { name: /^Searching\b/ }).click();
  await expect(page.getByText('No target fits these filters.', { exact: true })).toBeVisible();
  await expect(inspect).toHaveCount(0);
  const openStuck = async () => {
    await page.getByRole('tab', { name: /^Stuck\b/ }).click();
    await expect(inspect).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rejected releases' })).toBeVisible();
  };
  await openStuck();
  const titles = table.getByText(/^(?:Movie\.Name|Other\.Movie)\.2019\./);
  await expect(titles).toHaveCount(LOW.length + 3);
  const order = await titles.allTextContents();
  expect(order.toSorted()).toEqual([...LOW, TINY, WRONG, CORRUPT].sort());
  expect(order.filter((title) => LOW.includes(title))).toEqual(LOW);
  expect(order.at(-1)).toBe(CORRUPT);
  expect(order.indexOf(RELEASE)).toBeGreaterThanOrEqual(8);
  await page.reload();
  await openStuck();
  await expect(titles).toHaveText(order);
  expect(stack.tracker.state.downloads).toContain(CORRUPT);
  expect(stack.addRequests()).toHaveLength(0);

  const wrong = table.getByRole('row').filter({ hasText: WRONG });
  await expect(wrong).toBeVisible();
  await expect(wrong).toContainText('The title of the release is not this title.');

  await wrong.getByRole('button', { name: 'Files in the torrent' }).click();
  const torrent = page.getByRole('dialog', { name: 'Torrent' });
  await expect(torrent).toBeVisible();
  await expect(torrent.getByRole('tree', { name: 'Files in the torrent' })).toContainText(WRONG);
  await page.keyboard.press('Escape');
  await expect(torrent).toBeHidden();

  const chosen = table.getByRole('row').filter({ hasText: RELEASE });
  await expect(chosen).toContainText('720p BluRay (5.9 GiB)');
  await expect(chosen).toContainText('The quality of the release is not in the allowed qualities.');
  const tiny = table.getByRole('row').filter({ hasText: TINY });
  await expect(tiny).toContainText('1080p WEB-DL (10.0 MiB)');
  await expect(tiny).toContainText('The file is smaller than the quality allows for this runtime.');
  const reads = stack.tracker.state.downloads.length;
  await chosen.getByRole('button', { name: /^Download 720p BluRay/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Download this release?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();

  await expect.poll(() => [...stack.qbit.torrents.values()].map(({ name }) => name), { timeout: 60_000 }).toEqual([RELEASE]);
  expect(stack.tracker.state.downloads.slice(reads)).toEqual([RELEASE]);
  expect(stack.addRequests()).toHaveLength(1);
});

test('downloads every episode with one submission when a season pack rejected for quality is accepted', async ({ page }) => {
  const title = 'Show.Name.S01.720p.WEB-DL-GRP';
  const episodes = [1, 2, 3];
  const files = episodes.map((n) => `Show.Name.S01E0${n}.mkv`);
  const pack = { title, size: 3 * 60 * 45 * MIB, files };
  stack.tracker.state.answer = (url) => url.searchParams.get('season') === '1' && !url.searchParams.has('ep') ? [pack] : [];
  expect((await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' })).status).toBe(201);

  await page.goto(`${URL_BASE}/activity`);
  await page.getByRole('button', { name: 'Inspect Show Name (2020) Season 1' }).click();
  const row = page.getByRole('table', { name: 'Rejected releases' }).getByRole('row').filter({ hasText: title });
  await expect(row).toContainText('The quality of the release is not in the allowed qualities.', { timeout: 60_000 });
  expect(stack.addRequests()).toHaveLength(0);
  await row.getByRole('button', { name: /^Download 720p WEB-DL/ }).click();
  const grab = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/releases/grab'));
  await page.getByRole('dialog', { name: 'Download this release?' }).getByRole('button', { name: 'Download', exact: true }).click();
  const response = await grab;
  expect(response.request().postDataJSON()).toMatchObject({ guid: title, scope: 'season' });
  expect(response.ok()).toBe(true);

  await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
  const table = page.getByRole('table', { name: 'Episodes of season 1' });
  for (const n of episodes) {
    await expect(table.locator(`[data-row="entry:tv:1:1x${n}"]`)).toContainText('Downloading', { timeout: 45_000 });
  }
  expect([...stack.qbit.torrents.values()].map(({ name }) => name)).toEqual([title]);
  expect(stack.addRequests()).toHaveLength(1);
});
