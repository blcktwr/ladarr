import { expect, test } from './fixtures.ts';
import { configure, MIB, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(90_000);

// A 720p BluRay that the default 1080p/2160p profiles reject. The automatic search ends with every release rejected.
const RELEASE = 'Movie.Name.2019.720p.BluRay.x264-LOW';
// A release of another title. The search finds it, so the inspector lists it, but a manual grab cannot take it.
const WRONG = 'Other.Movie.2019.1080p.BluRay-WRONG';

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  stack.tracker.state.items = [
    { title: RELEASE, size: 60 * 100 * MIB },
    { title: WRONG, size: 100 * 120 * MIB },
  ];
  const movie = await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' });
  if (movie.status >= 300) throw new Error(`POST /library answered ${movie.status}: ${JSON.stringify(movie.body)}`);
  await expect.poll(async () => (await stack.call('GET', '/queue/entries/movie:2')).body.entry?.key, { timeout: 60_000 }).toBe('no_match');
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('downloads a release that the automatic search rejected', async ({ page }) => {
  await page.goto(`${URL_BASE}/activity`);
  await page.getByRole('button', { name: 'Inspect Movie Name (2019)' }).click();
  await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();

  // The inspector lists every release that the search rejected. A release of another title shows its reason and has
  // no download button.
  const wrong = page.getByRole('listitem').filter({ hasText: WRONG });
  await expect(wrong).toBeVisible();
  await expect(wrong).toContainText('The title of the release is not this title.');
  await expect(wrong.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Download .*WRONG/ })).toHaveCount(0);

  // A 720p BluRay that only the profile rejected keeps its button. A person can take it by hand.
  const releaseLine = page.getByText('720p').filter({ hasText: 'BluRay' }).first();
  await expect(releaseLine).toBeVisible();
  const download = page.getByRole('button', { name: /^Download 720p BluRay/ });
  await expect(download).toBeVisible();
  await download.click();

  const dialog = page.getByRole('dialog', { name: 'Download this release?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();

  await expect.poll(async () => (await stack.call('GET', '/queue/entries/movie:2')).body.entry?.stage, { timeout: 60_000 }).toBe('downloading');
  await expect.poll(() => [...stack.qbit.torrents.values()].some((torrent) => torrent.name === RELEASE), { timeout: 60_000 }).toBe(true);
});
