import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(90_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The series enters the queue first, so its row is the first row and the movie is the second row.
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

test('puts the inspector of the first row back at the top when the detail returns to it', async ({ page }) => {
  await page.goto(`${URL_BASE}/activity`);
  const seriesRow = page.locator('[data-row="group:tv:1:1"]');
  const movieRow = page.locator('[data-row="entry:movie:2"]');
  // A panel that leaves the flow has an inline top, so the check follows the part that moves the panel.
  const moved = page.locator('main div[style*="top:"]');
  await expect(movieRow).toBeVisible();
  await expect(moved).toHaveCount(0);

  // A click on the second row opens its detail beside the row.
  await movieRow.click();
  await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await expect(moved).toHaveCount(1);

  // The movie leaves the queue, so the first row holds the detail again. The panel goes back to the top of the list,
  // in the flow, and it does not stay at the row that left.
  const plan = await stack.call('POST', '/library/plans', { action: 'remove', keys: ['movie:2'], deleteFiles: false });
  const applied = await stack.call('POST', `/library/plans/${plan.body.planId}/apply`, {});
  expect(applied.status).toBe(200);
  await expect(movieRow).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Show Name (2020) Season 1' })).toBeVisible();
  await expect(seriesRow).toBeVisible();
  await expect(moved).toHaveCount(0);
});
