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
    ['POST', '/settings/complete-setup', {}],
    ['POST', '/backups', {}],
  ] as const) {
    const res = await stack.call(method, path, body);
    if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
});
test.afterAll(() => stack.stop());

const texts = /No download client is set\.|No indexer is set\./;

test('shows the alerts in order on every page load while the problem is there', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(URL_BASE);
  const notices = page.getByRole('region', { name: 'Notifications' });
  const closers = notices.locator('button[aria-label="Close"]');

  // The problems come first, and the order is the order of their IDs. Only the oldest alert has text.
  await expect(notices.getByText('No download client is set.')).toBeVisible();
  await expect(notices.getByText('No indexer is set.')).toHaveCount(0);
  await expect(notices.getByText('Open settings', { exact: true })).toBeVisible();
  await closers.first().click();

  await expect(notices.getByText('No indexer is set.')).toBeVisible();
  await closers.first().click();
  await expect(closers).toHaveCount(0);

  // A page change does not open a closed alert again.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Catalog', exact: true }).click();
  await page.waitForTimeout(1000);
  await expect(notices.getByText(texts)).toHaveCount(0);
  await expect(closers).toHaveCount(0);

  // A new visit opens the alerts again, because the problems are still there.
  await page.reload();
  await expect(notices.getByText('No download client is set.')).toBeVisible();
  await closers.first().click();
  await expect(notices.getByText('No indexer is set.')).toBeVisible();
});

test('the action of an alert opens its page', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(URL_BASE);
  const notices = page.getByRole('region', { name: 'Notifications' });

  await notices.getByText('Open settings', { exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);

  // A new visit opens the alert again.
  await page.goto(URL_BASE);
  await expect(notices.getByText('No download client is set.')).toBeVisible();
});

test('shows the same alert in a new tab', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(URL_BASE);
  const notices = page.getByRole('region', { name: 'Notifications' });
  const closers = notices.locator('button[aria-label="Close"]');

  await expect(notices.getByText('No download client is set.')).toBeVisible();
  await closers.first().click();
  await expect(notices.getByText('No indexer is set.')).toBeVisible();
  await closers.first().click();
  await expect(closers).toHaveCount(0);

  // A second tab of the same browser opens the alerts again, because the problems are still there.
  const second = await context.newPage();
  await second.goto(URL_BASE);
  const secondNotices = second.getByRole('region', { name: 'Notifications' });
  await expect(secondNotices.getByText('No download client is set.')).toBeVisible();
  await second.close();
});

test('the alerts wait while a modal is open', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/catalog/tv/3`);
  const notices = page.getByRole('region', { name: 'Notifications' });

  await expect(notices.getByText('No download client is set.')).toBeVisible();
  await page.getByRole('button', { name: 'Add Season 1' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(notices.getByText('No download client is set.')).toHaveCount(0);

  // The modal is closed, so the alerts come back.
  await page.keyboard.press('Escape');
  await expect(notices.getByText('No download client is set.')).toBeVisible();

  // An alert that the person closed stays closed after a modal.
  await notices.locator('button[aria-label="Close"]').first().click();
  await expect(notices.getByText('No indexer is set.')).toBeVisible();
  await page.getByRole('button', { name: 'Add Season 1' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notices.getByText('No indexer is set.')).toBeVisible();
  await expect(notices.getByText('No download client is set.')).toHaveCount(0);
});

test('the notice of a removal shows in front of the problems of the app', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 3, add: 'paused' });
  expect(added.status).toBe(201);
  await page.goto(`${URL_BASE}/catalog/tv/3`);
  const notices = page.getByRole('region', { name: 'Notifications' });
  await expect(notices.getByText('No download client is set.')).toBeVisible();

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Delete 1 title?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  // The removal ends in a modal too, so its notice must stay in front of the problems that come back.
  await expect(notices.getByText('Two Seasons removed from the library')).toBeVisible();
});

test('the notice of an add shows in front of the problems of the app', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/catalog/tv/3`);
  const notices = page.getByRole('region', { name: 'Notifications' });

  // The app has its problems already. The user adds a series, which asks for its seasons in a modal.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add new series' });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  // The modal closes before the notice, so the problems that come back do not hide it.
  await expect(notices.getByText('Added to the queue')).toBeVisible();
  // The problems come back when the modal closes, and the notice stays in front of them.
  await page.waitForTimeout(1000);
  await expect(notices.getByText('Added to the queue')).toBeVisible();
});
