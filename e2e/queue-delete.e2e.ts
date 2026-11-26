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

test('deletes a season of a series and a movie from the queue with the modal of the library', async ({ page }) => {
  // Both downloads are in the client before the deletion, so the deletion has a torrent to remove.
  await expect.poll(async () => (await stack.call('GET', '/queue/groups/tv:1')).body.items.every((item: { hasTorrent: boolean }) => item.hasTorrent), { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await stack.call('GET', '/queue/entries/movie:2')).body.entry?.hasTorrent, { timeout: 60_000 }).toBe(true);
  expect(stack.qbit.torrents.size).toBe(2);

  // The catalog has both titles before the deletion.
  await page.goto(`${URL_BASE}/catalog`);
  await expect(page.getByText('Show Name', { exact: true })).toBeVisible();
  await expect(page.getByText('Movie Name', { exact: true })).toBeVisible();
  await page.locator('a[href$="/activity"]').click();

  // The season is the first row, so its inspector is open. Its deletion removes the season, not the series.
  await page.getByRole('button', { name: 'Actions for Show Name (2020) Season 1' }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const seasonAlert = page.getByRole('alertdialog', { name: 'Delete Season 1?' });
  await expect(seasonAlert).toBeVisible();
  // The deletion from the queue deletes the files unless the user turns the switch off.
  await expect(seasonAlert.getByRole('switch', { name: 'Delete the files too' })).toBeChecked();
  await seasonAlert.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('[data-row="group:tv:1:1"]')).toHaveCount(0);
  await expect.poll(async () => (await stack.call('GET', '/library/tv:1')).status, { timeout: 30_000 }).toBe(200);
  await expect.poll(() => [...stack.qbit.torrents.values()].some((torrent) => torrent.name.includes('Show.Name')), { timeout: 30_000 }).toBe(false);
  expect(stack.qbit.calls).toContainEqual(expect.objectContaining({ path: 'torrents/delete', body: expect.stringContaining('"deleteFiles":"true"') }));

  // The catalog keeps the series and the movie.
  await page.locator('a[href$="/catalog"]').click();
  await expect(page.getByText('Show Name', { exact: true })).toBeVisible();
  await expect(page.getByText('Movie Name', { exact: true })).toBeVisible();
  await page.locator('a[href$="/activity"]').click();

  // The movie has the same menu and the same modal. The user clears the checkbox, so the catalog loses the title and
  // the torrent and its files stay.
  await page.locator('[data-row="entry:movie:2"]').click();
  await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Movie Name (2019)' }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const movieAlert = page.getByRole('alertdialog', { name: 'Delete Movie Name?' });
  await expect(movieAlert).toBeVisible();
  const deleteFiles = movieAlert.getByRole('checkbox', { name: 'Delete the files too' });
  await expect(deleteFiles).toBeChecked();
  await deleteFiles.click();
  await expect(deleteFiles).not.toBeChecked();
  await movieAlert.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await stack.call('GET', '/library/movie:2')).status, { timeout: 30_000 }).toBe(404);
  await expect(page.locator('[data-row="entry:movie:2"]')).toHaveCount(0);
  expect([...stack.qbit.torrents.values()].some((torrent) => torrent.name.includes('Movie.Name'))).toBe(true);
  expect(stack.qbit.calls.some((call) => call.path === 'torrents/delete' && call.body?.includes('"deleteFiles":"false"'))).toBe(false);

  // The catalog loses the movie too.
  await page.locator('a[href$="/catalog"]').click();
  await expect(page.getByText('Movie Name', { exact: true })).toHaveCount(0);
});

test('deletes only the season that the row of the queue names', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 3, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
  await expect.poll(async () => (await stack.call('GET', '/queue/groups/tv:3')).body.items.length, { timeout: 60_000 }).toBe(4);

  await page.goto(`${URL_BASE}/activity`);
  const first = page.locator('[data-row="group:tv:3:1"]');
  const second = page.locator('[data-row="group:tv:3:2"]');
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await first.click();
  await page.getByRole('button', { name: 'Actions for Two Seasons (2021) Season 1' }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const alert = page.getByRole('alertdialog', { name: 'Delete Season 1?' });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: 'Delete', exact: true }).click();

  // The queue loses the season that the row names, and keeps the other one.
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await expect.poll(async () => (await stack.call('GET', '/queue/groups/tv:3')).body.items.every((item: { season: number }) => item.season === 2)).toBe(true);
  // The series stays in the library with the other season.
  const detail = await stack.call('GET', '/library/tv:3');
  expect(detail.status).toBe(200);
  expect(detail.body.title.seasons).toMatchObject([{ seasonNumber: 1, override: 'unmonitored' }, { seasonNumber: 2, override: null }]);
});
