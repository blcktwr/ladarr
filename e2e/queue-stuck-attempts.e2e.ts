import { expect, test } from './fixtures.ts';
import { configure, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const reason = () => stack.call('GET', '/queue/entries/tv:1:1x1').then((res) => res.body.entry?.reason);

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The release of the season is not a torrent, so each attempt fails and the season asks for the user.
  stack.tracker.state.items = [{ title: SERIES_PACK, size: 3 * 60 * 45 * 1024 * 1024, bad: true }];
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('says what failed and offers the release by hand on the card of the season', async ({ page }) => {
  // The reason carries the failure of the last release, so the page says what went wrong.
  await expect.poll(reason, { timeout: 60_000 }).toMatchObject({ code: 'too_many_attempts', detail: 'invalid_torrent' });

  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="group:tv:1:1"]').click();
  const main = page.getByRole('main');
  await expect(main.getByText('Several releases failed. Select a release by hand, or try again. The last release had a damaged .torrent file.')).toBeVisible();

  // The card offers the release by hand. The retry of the season comes from its menu only.
  await expect(main.getByRole('button', { name: 'Try again', exact: true })).toBeHidden();
  await main.getByRole('button', { name: 'Choose a release for Show Name (2020) Season 1' }).click();

  // The panel searches the indexers, and the person takes any release that it finds.
  const panel = page.getByRole('dialog', { name: 'Choose a release for Show Name (2020) Season 1' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(SERIES_PACK)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
});
