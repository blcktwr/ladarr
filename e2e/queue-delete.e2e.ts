import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  for (const body of [
    { mediaType: 'tv', tmdbId: 1, add: 'all' },
    { mediaType: 'movie', tmdbId: 2, add: 'all' },
  ]) {
    const added = await stack.call('POST', '/library', body);
    if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
  }
  await expect.poll(async () => (await stack.call('GET', '/queue/groups/tv:1')).body.items.length, { timeout: 60_000 }).toBe(3);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('deletes a series and a movie from the queue with the modal of the library', async ({ page }) => {
  await page.goto(`${URL_BASE}/activity`);

  // The series is the first row, so its inspector is open.
  await page.getByRole('button', { name: 'Actions for Show Name (2020) Season 1' }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const seriesAlert = page.getByRole('alertdialog', { name: 'Delete 1 title?' });
  await expect(seriesAlert).toBeVisible();
  await expect(seriesAlert.getByRole('switch', { name: 'Delete the files too' })).toBeVisible();
  await seriesAlert.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await stack.call('GET', '/library/tv:1')).status, { timeout: 30_000 }).toBe(404);
  await expect(page.locator('[data-row="group:tv:1:1"]')).toHaveCount(0);

  // The movie has the same menu and the same modal.
  await page.locator('[data-row="entry:movie:2"]').click();
  await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Movie Name (2019)' }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const movieAlert = page.getByRole('alertdialog', { name: 'Delete 1 title?' });
  await expect(movieAlert).toBeVisible();
  await movieAlert.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await stack.call('GET', '/library/movie:2')).status, { timeout: 30_000 }).toBe(404);
  await expect(page.locator('[data-row="entry:movie:2"]')).toHaveCount(0);
});
