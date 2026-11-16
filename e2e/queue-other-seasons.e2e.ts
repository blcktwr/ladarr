import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

// The releases count the last two episodes of the catalog season as their season 2.
const RANGE = { season: 1, from: 2, to: 3, releaseSeason: 2, releaseFrom: 1 };
const RELEASE_PACK = 'Show.Name.S02.1080p.WEB-DL.DDP5.1-GRP';

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const reason = () => stack.call('GET', '/queue/entries/tv:1:1x3').then((res) => res.body.entry?.reason);

async function waitFor(check: () => Promise<boolean>, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timeout waiting for the stack');
}

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The queue waits while the test saves the numbering, so the first search already uses it.
  await stack.call('POST', '/queue/pause', { paused: true });
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
  // The map needs the episodes of the series, so the test waits for the metadata.
  await waitFor(async () => {
    const detail = await stack.call('GET', '/library/tv:1');
    return Boolean(detail.body.title?.episodesLoadedAt);
  });
  const saved = await stack.call('PATCH', '/library/tv:1', { numbering: { revision: 0, ranges: [RANGE] } });
  if (saved.status >= 300) throw new Error(`PATCH /library/tv:1 answered ${saved.status}: ${JSON.stringify(saved.body)}`);
  // The pack of the release season names its episodes and holds one of the two mapped ones, so the other target asks
  // the user for the other seasons of the releases.
  stack.tracker.state.items = [
    { title: RELEASE_PACK, size: 2 * 60 * 45 * 1024 * 1024, files: ['Show.Name.S02E01.mkv', 'Show.Name.S02E03.mkv'] },
  ];
  await stack.call('POST', '/queue/pause', { paused: false });
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('offers the search of the other seasons on the card of the season', async ({ page }) => {
  // The pack did not hold every episode of its release season, so the target waits for the user.
  await expect.poll(reason, { timeout: 60_000 }).toMatchObject({ code: 'pack_partial' });

  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="group:tv:1:1"]').click();
  const main = page.getByRole('main');
  // The card says why the episode waits, and it starts the search of the other seasons of the releases.
  await expect(main.getByText('The pack did not hold every episode of the season.')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Search individually' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Choose episodes' })).toBeVisible();
  // The retry of the season comes from the menu of the three points, not from the card.
  await expect(main.getByRole('button', { name: 'Try again', exact: true })).toBeHidden();
});

test('manages the episodes of a stuck target in the queue', async ({ page }) => {
  await expect.poll(reason, { timeout: 60_000 }).toMatchObject({ code: 'pack_partial' });

  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="group:tv:1:1"]').click();
  await page.getByRole('main').getByRole('button', { name: 'Choose episodes' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The row shows the catalog range and the release episodes that it names.
  await expect(dialog.getByRole('spinbutton', { name: 'Catalog season', exact: true })).toHaveValue('1');
  await expect(dialog.getByRole('spinbutton', { name: 'First catalog episode', exact: true })).toHaveValue('2');
  await expect(dialog.getByRole('spinbutton', { name: 'Last catalog episode', exact: true })).toHaveValue('3');
  await expect(dialog.getByRole('spinbutton', { name: 'Release season', exact: true })).toHaveValue('2');
  await expect(dialog.getByRole('spinbutton', { name: 'First release episode', exact: true })).toHaveValue('1');
  await expect(dialog.getByText('S02E01–S02E02')).toBeVisible();
});

test('lists every episode of the season under the tab that filters the rows', async ({ page }) => {
  await expect.poll(reason, { timeout: 60_000 }).toMatchObject({ code: 'pack_partial' });

  await page.goto(`${URL_BASE}/activity`);
  await page.getByRole('tab', { name: /Stuck/ }).click();
  await page.locator('[data-row="group:tv:1:1"]').click();
  await page.locator('[data-row="season:tv:1|1"]').click();
  // The tab filters the rows of the page. The season keeps its whole list, and the episodes of the pack show with
  // their own status beside the one that waits for the user.
  const episodes = page.getByRole('table', { name: 'Episodes of season 1' });
  await expect(episodes.locator('[data-row="entry:tv:1:1x1"]')).toBeVisible();
  await expect(episodes.locator('[data-row="entry:tv:1:1x2"]')).toBeVisible();
  await expect(episodes.locator('[data-row="entry:tv:1:1x3"]')).toContainText('Stuck');
  // The row of an episode has no menu of actions.
  await expect(episodes.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
});
