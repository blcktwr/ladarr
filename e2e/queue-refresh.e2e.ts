import type { Route } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { configure, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(90_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The series goes in the queue first, so its row is the first row of the page. Its pack has three episodes.
  const series = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (series.status >= 300) throw new Error(`POST /library answered ${series.status}: ${JSON.stringify(series.body)}`);
  await expect.poll(async () => (await stack.call('GET', '/queue/groups/tv:1')).body.items.length, { timeout: 60_000 }).toBe(3);
  const movie = await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' });
  if (movie.status >= 300) throw new Error(`POST /library answered ${movie.status}: ${JSON.stringify(movie.body)}`);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('keeps the queue on a failed action and a failed refresh', async ({ page }) => {
  await page.goto(`${URL_BASE}/activity`);
  const main = page.getByRole('main');
  await expect(main.getByText('Movie Name (2019)', { exact: true })).toBeVisible();
  const pageGrid = main.locator(':scope > div').first();
  const children = await pageGrid.locator(':scope > *').count();

  // The action fails. The toast says it, and it adds no empty container to the page.
  const refused = (route: Route) => route.abort();
  await page.route('**/api/queue/pause', refused, { times: 1 });
  await main.getByRole('button', { name: 'Pause the queue' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('The action did not complete.')).toBeVisible();
  expect(await pageGrid.locator(':scope > *').count()).toBe(children);

  // A refresh fails. The rows that the page shows stay, and the page asks for them again later.
  await page.route('**/api/queue?*', refused);
  await main.getByRole('button', { name: 'Pause the queue' }).click();
  await expect(main.getByRole('button', { name: 'Resume the queue' })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(main.getByText('Movie Name (2019)', { exact: true })).toBeVisible();
  await expect(main.getByText('The request did not complete.')).toHaveCount(0);
});

test('shows the part of a download that the client reports, without a reload', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`${URL_BASE}/activity`);
  await page.getByRole('button', { name: 'Inspect Show Name (2020) Season 1' }).click();
  await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
  const table = page.getByRole('table', { name: 'Episodes of season 1' });
  await expect(table).toBeVisible();

  // The client reports a part at its next poll. The page shows it with no reload.
  await expect.poll(() => [...stack.qbit.torrents.values()].some((torrent) => torrent.name === SERIES_PACK), { timeout: 60_000 }).toBe(true);
  const torrent = [...stack.qbit.torrents.values()].find((item) => item.name === SERIES_PACK)!;
  stack.qbit.progress(torrent.hash, 0.5);
  await expect
    .poll(async () => (await stack.call('GET', '/queue/groups/tv:1')).body.items[0]?.transfer?.progress, { timeout: 90_000, intervals: [2_000] })
    .toBe(0.5);
  await expect(table).toContainText('(50%)', { timeout: 10_000 });
});

test('shows the selected title in the inspector', async ({ page }) => {
  await page.goto(`${URL_BASE}/activity`);
  const seriesRow = page.locator('[data-row="group:tv:1:1"]');
  const movieRow = page.locator('[data-row="entry:movie:2"]');
  const inspectSeries = page.getByRole('button', { name: 'Inspect Show Name (2020) Season 1' });
  const inspectMovie = page.getByRole('button', { name: 'Inspect Movie Name (2019)' });

  // The first row is selected when the page opens, so the inspector shows the series and its seasons.
  await expect(seriesRow).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Show Name (2020) Season 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Seasons' })).toBeVisible();
  await expect(inspectSeries).toHaveAttribute('aria-pressed', 'true');
  await expect(inspectMovie).toHaveAttribute('aria-pressed', 'false');

  // A click on the row of the movie selects it.
  await movieRow.click();
  await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Seasons' })).toHaveCount(0);
  await expect(inspectMovie).toHaveAttribute('aria-pressed', 'true');
  await expect(inspectSeries).toHaveAttribute('aria-pressed', 'false');

  // Below 800 px the list shows alone, and the button of a row opens the inspector of that title.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeHidden();
  await inspectMovie.click();
  await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Queue' })).toBeHidden();

  // The button at the top of the inspector returns to the list, with the focus on the button of the title that was open.
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Queue' })).toBeVisible();
  await expect(inspectMovie).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });
});
