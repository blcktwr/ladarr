import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';
import { expect, test } from './fixtures.ts';
import { addClient, configure, MIB, MOVIE_RELEASE, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
test.beforeEach(async ({ context }) => {
  stack = await startStack();
  const cookie = await stack.createOwner();
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});
test.afterEach(() => stack?.stop());

test('puts the inspector of the first row back at the top when the detail returns to it', async ({ page }) => {
  await configure(stack);
  // The series enters the queue first, so its row is the first row and the movie is the second row.
  const series = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (series.status >= 300) throw new Error(`POST /library answered ${series.status}: ${JSON.stringify(series.body)}`);
  await expect.poll(async () => (await stack.call('GET', '/queue/groups/tv:1')).body.items.length, { timeout: 60_000 }).toBe(3);
  const movie = await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' });
  if (movie.status >= 300) throw new Error(`POST /library answered ${movie.status}: ${JSON.stringify(movie.body)}`);

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

test('keeps verified metadata in Fetching until a client is configured', async ({ page }) => {
  await configure(stack, { client: false });
  expect((await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' })).status).toBe(201);

  await page.goto(`${URL_BASE}/activity`);
  const row = page.locator('[data-row="entry:movie:2"]');
  await expect.poll(() => stack.tracker.state.downloads, { timeout: 30_000 }).toEqual([MOVIE_RELEASE]);
  await expect(row).toContainText('Fetching');
  await expect(page.getByText(MOVIE_RELEASE, { exact: true })).toBeVisible();
  expect(stack.addRequests()).toHaveLength(0);

  await addClient(stack);
  await expect.poll(() => stack.qbit.torrents.has(hashOf(MOVIE_RELEASE)), { timeout: 40_000 }).toBe(true);
  await expect(row).toContainText('Downloading');
  expect(stack.tracker.state.downloads).toEqual([MOVIE_RELEASE]);
  expect(stack.addRequests()).toHaveLength(1);
});

test('shows each prepared torrent while the only download slot is full', async ({ page }) => {
  await configure(stack, { client: false });
  await addClient(stack, 1);
  const movieHash = hashOf(MOVIE_RELEASE);
  expect((await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' })).status).toBe(201);
  await expect.poll(() => stack.qbit.torrents.has(movieHash), { timeout: 30_000 }).toBe(true);
  stack.qbit.progress(movieHash, 0.4);

  const files = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'];
  const double = 'Show.Name.S01E01E02.1080p.WEB-DL-GRP';
  const single = 'Show.Name.S01E03.1080p.BluRay-GRP';
  const doubleHash = hashOf(double, files);
  const singleHash = hashOf(single);
  const both = { title: double, size: 2 * 60 * 45 * MIB, files };
  const episode = { title: single, size: 60 * 45 * MIB };
  stack.tracker.state.items = [both, episode];
  stack.tracker.state.answer = (url) => {
    if (url.searchParams.get('season') !== '1') return [];
    const number = url.searchParams.get('ep');
    return number === null ? [both] : Number(number) === 3 ? [episode] : [];
  };
  expect((await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' })).status).toBe(201);
  await page.goto(`${URL_BASE}/activity`);
  const row = page.locator('[data-row="group:tv:1:1"]');
  await row.getByRole('button', { name: 'Inspect Show Name (2020) Season 1' }).click();
  await expect.poll(() => [...stack.tracker.state.downloads].sort(), { timeout: 30_000 }).toEqual([MOVIE_RELEASE, double, single].sort());
  await expect(row).toContainText('Fetching');
  for (const detail of [double, single, 'WEB-DL 1080p', 'BluRay 1080p', '5.3 GiB', '2.6 GiB']) {
    await expect(page.getByText(detail, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Releases', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/\d+\s*(?:\/|of)\s*\d+\s+episodes/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Files in the torrent' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
  await expect(page.getByRole('table', { name: 'Episodes of season 1' })).toBeVisible();
  expect(stack.addRequests()).toHaveLength(1);

  stack.complete(MOVIE_RELEASE, { [`${MOVIE_RELEASE}.mkv`]: 'movie' });
  const accepted = () => [doubleHash, singleHash].filter((hash) => stack.qbit.torrents.has(hash));
  await expect.poll(() => accepted().length, { timeout: 40_000 }).toBe(1);
  expect(stack.addRequests()).toHaveLength(2);
  if (accepted().includes(doubleHash)) {
    stack.complete(double, { [files[0]!]: 'one', [files[1]!]: 'two' }, doubleHash);
  } else {
    stack.complete(single, { [`${single}.mkv`]: 'three' });
  }
  await expect.poll(accepted, { timeout: 40_000 }).toEqual([doubleHash, singleHash]);
  expect(stack.addRequests()).toHaveLength(3);
  expect([...stack.tracker.state.downloads].sort()).toEqual([MOVIE_RELEASE, double, single].sort());
});
