import type { Page } from '@playwright/test';
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

// The alerts of this stack, in the order of the endpoint.
const ALERTS = [
  { title: 'No download client is set.', message: 'Add qBittorrent in Settings.' },
  { title: 'No indexer is set.', message: 'Add an indexer in Settings.' },
];
const TITLES = ALERTS.map((item) => item.title);

// The toast region shows the alerts one at a time: closing the front one shows the next.
async function closeToasts(page: Page) {
  const notices = page.getByRole('region', { name: 'Notifications' });
  const closers = notices.locator('button[aria-label="Close"]');
  for (const title of TITLES) {
    await expect(notices.getByText(title)).toBeVisible();
    await closers.first().click();
    await expect(notices.getByText(title)).toBeHidden();
  }
  await expect(closers).toHaveCount(0);
}

// Every alert is on the page at once, with its title and its message, in the order of the endpoint.
async function expectAlertsInOrder(page: Page) {
  const main = page.getByRole('main');
  for (const { title, message } of ALERTS) {
    await expect(main.getByText(title)).toBeVisible();
    await expect(main.getByText(message)).toBeVisible();
  }
  const text = await main.innerText();
  expect(text.indexOf(ALERTS[0]!.title)).toBeLessThan(text.indexOf(ALERTS[1]!.title));
}

test('lists every alert on the Alerts page, including the ones closed as toasts', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  // A wide window shows whether the page keeps its container or fills the window.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(URL_BASE);
  await closeToasts(page);

  // The section comes after Settings. Its item is the bell only, and the label stays for the screen reader.
  const sections = page.getByRole('navigation', { name: 'Sections' });
  const links = sections.getByRole('link');
  await expect(links).toHaveCount(4);
  for (const [index, name] of ['Catalog', 'Calendar', 'Settings', 'Alerts'].entries()) {
    await expect(links.nth(index)).toHaveAccessibleName(name);
  }
  await expect(links.nth(3)).toHaveText('');
  await links.nth(3).click();
  await expect(page).toHaveURL(/\/alerts$/);
  // The icon of this section has no active mark, so no section link says that it is the current page.
  await expect(sections.locator('[aria-current="page"]')).toHaveCount(0);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();

  // The alerts are rows of a table, under the columns that say what each part is.
  const table = main.getByRole('table', { name: 'Alerts' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText(['Alert', 'What to do', 'Actions']);
  await expect(table.getByRole('row')).toHaveCount(3);

  // The table sits in the page container: it does not fill the window, and it is centered.
  const box = await table.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(1200);
  expect(box!.width).toBeGreaterThanOrEqual(1000);
  expect(box!.x).toBeGreaterThanOrEqual(100);

  // Closing the toasts removes nothing from the page.
  await expectAlertsInOrder(page);
  await expect(main.getByText('Open settings', { exact: true })).toHaveCount(2);
});

test('keeps the alerts after a reload and opens the toasts again', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/alerts`);
  await closeToasts(page);

  // The page reads the list of the server, so the alerts are there with no toast open.
  const main = page.getByRole('main');
  for (const title of TITLES) await expect(main.getByText(title)).toBeVisible();

  // A new visit opens the alerts again, because the problems are still there.
  await page.reload();
  await closeToasts(page);
  for (const title of TITLES) await expect(main.getByText(title)).toBeVisible();
});

test('the action of an alert opens its page', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/alerts`);
  await closeToasts(page);

  const main = page.getByRole('main');
  await main.getByText('Open settings', { exact: true }).first().click();
  await expect(page).toHaveURL(/\/settings#connections$/);
});
