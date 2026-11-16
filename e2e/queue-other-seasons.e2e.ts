import { expect, test } from './fixtures.ts';
import { configure, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const reason = () => stack.call('GET', '/queue/entries/tv:1:1x3').then((res) => res.body.entry?.reason);

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The pack names its episodes and holds two of the three of the season, so the third target asks the user for the
  // other seasons of the releases.
  stack.tracker.state.items = [{ title: SERIES_PACK, size: 2 * 60 * 45 * 1024 * 1024, files: ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'] }];
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('offers the search of the other seasons on the card of the season', async ({ page }) => {
  // The pack did not hold every episode of the season, so the target waits for the user.
  await expect.poll(reason, { timeout: 60_000 }).toMatchObject({ code: 'pack_partial' });

  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="group:tv:1:1"]').click();
  const main = page.getByRole('main');
  // The card says why the episode waits, and it starts the search of the other seasons of the releases.
  await expect(main.getByText('The pack did not hold every episode of the season.')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Search other seasons' })).toBeVisible();
  // The retry of the season comes from the menu of the three points, not from the card.
  await expect(main.getByRole('button', { name: 'Try again', exact: true })).toBeHidden();
});
