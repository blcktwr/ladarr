import { expect, test } from './fixtures.ts';
import { configure, MIB, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const LOW = 'Show.Name.S01.720p.WEB-DL-LOW';
const INVALID = 'The torrent is invalid.';
const QUALITY = 'The quality of the release is not in the allowed qualities.';

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  stack.tracker.state.items = [
    { title: SERIES_PACK, size: 3 * 60 * 45 * MIB, bad: true },
    { title: LOW, size: 3 * 60 * 45 * MIB },
  ];
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('shows why each candidate was rejected in the Stuck season', async ({ page }) => {
  await expect.poll(async () => (await stack.call('GET', '/queue/groups/tv:1?season=1')).body.group, { timeout: 60_000 }).toMatchObject({
    status: 'stuck',
    tabs: ['stuck'],
    problem: { code: 'all_rejected' },
    rejected: [
      { release: { title: LOW, reasons: [QUALITY], selectable: true } },
      { release: { title: SERIES_PACK, reasons: [INVALID], selectable: false } },
    ],
  });
  const { body } = await stack.call('GET', '/queue/entries/tv:1:1x1');
  expect(body.entry).toMatchObject({
    status: 'stuck',
    reason: { code: 'all_rejected' },
    search: { nextAt: null, topRejections: expect.arrayContaining(['invalid_torrent']) },
  });

  await page.goto(`${URL_BASE}/activity`);
  await page.getByRole('tab', { name: /^Stuck\b/ }).click();
  const season = page.locator('[data-row="group:tv:1:1"]');
  await expect(season).toContainText('Stuck');
  await season.getByRole('button', { name: 'Inspect Show Name (2020) Season 1' }).click();
  const rejected = page.getByRole('table', { name: 'Rejected releases' });
  for (const [title, reason] of [[LOW, QUALITY], [SERIES_PACK, INVALID]] as const) {
    const row = rejected.getByRole('row').filter({ hasText: title });
    await expect(row.getByText(reason, { exact: true })).toBeVisible();
  }
  expect(stack.tracker.state.downloads).toEqual([SERIES_PACK]);
  expect(stack.addRequests()).toHaveLength(0);
});
