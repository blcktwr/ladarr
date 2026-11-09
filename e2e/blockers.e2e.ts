import { expect, test } from './fixtures.ts';
import { startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  // The setup has no indexer and no download client. The backup keeps the status to those two problems.
  for (const [method, path, body] of [
    ['POST', '/roots', { path: stack.folders.movies, mediaType: 'movie' }],
    ['POST', '/roots', { path: stack.folders.tv, mediaType: 'tv' }],
    ['PATCH', '/settings', { region: 'US', timeZone: 'UTC' }],
    ['POST', '/settings/complete-setup', {}],
    ['POST', '/backups', {}],
    ['POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' }],
  ] as const) {
    const res = await stack.call(method, path, body);
    if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  // The target stops for the missing indexer, so the alerts are complete before a page opens.
  await expect
    .poll(
      async () => {
        const items = (await stack.call('GET', '/queue')).body.items as { id: string; reason: { code: string } | null }[];
        return items.find((item) => item.id === 'movie:2')?.reason?.code ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe('no_indexers');
});
test.afterAll(() => stack.stop());

test('tells the person what blocks the app, and updates when a setting is fixed', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(URL_BASE);
  const notices = page.getByRole('region', { name: 'Notifications' });
  const closers = notices.locator('button[aria-label="Close"]');

  // The missing download client is the first problem, and the missing indexer follows.
  await expect(notices.getByText('No download client is set.')).toBeVisible();
  await expect(notices.getByText('No indexer is set.')).toHaveCount(0);
  await closers.first().click();
  await expect(notices.getByText('No indexer is set.')).toBeVisible();
  await closers.first().click();
  await expect(closers).toHaveCount(0);

  // The queue shows the target that stopped, and the queue cannot work without the settings.
  await page.locator('a[href$="/activity"]').click();
  const main = page.getByRole('main');
  await expect(main.getByText('Stuck').first()).toBeVisible();
  await expect(main.getByRole('button', { name: 'Pause the queue' })).toBeDisabled();

  // The indexer is set, so its problem ends. The download client problem stays.
  const added = await stack.call('POST', '/indexers', { name: 'Tracker', type: 'torznab', baseUrl: `http://127.0.0.1:${stack.tracker.port}/2/`, apiKey: 'indexer-key' });
  expect(added.status).toBe(201);
  // The indexer problem ended, so only the download client alert opens on the new visit.
  await page.reload();
  await expect(notices.getByText('No download client is set.')).toBeVisible();
  await expect(notices.getByText('No indexer is set.')).toHaveCount(0);

  // The Alerts page lists the current alerts: the indexer problem ended, and the download client problem stays.
  await page.getByRole('link', { name: 'Alerts' }).click();
  const table = page.getByRole('table', { name: 'Alerts' });
  await expect(table.getByText('No download client is set.')).toBeVisible();
  await expect(table.getByText('No indexer is set.')).toHaveCount(0);
});
