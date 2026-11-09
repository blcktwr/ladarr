import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(90_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('keeps the open log entry when new logs arrive', async ({ page }) => {
  // A request of its own, so its entry has an address that no other entry has.
  await stack.call('GET', '/auth/api-key?marker=first');

  await page.goto(`${URL_BASE}/settings#logs`);
  const main = page.getByRole('main');
  await main.getByRole('switch', { name: 'Live' }).click();
  const opened = main.getByRole('button', { name: /marker=first/ });
  await expect(opened).toBeVisible();

  // The entry opens in a side panel.
  await opened.click();
  const panel = page.getByRole('dialog', { name: /marker=first/ });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('/api/auth/api-key?marker=first');

  // A new entry arrives, and the panel keeps the entry that it showed.
  await stack.call('GET', '/auth/api-key?marker=second');
  await expect(main.getByRole('button', { name: /marker=second/ })).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('/api/auth/api-key?marker=first');
  await expect(panel).not.toContainText('marker=second');
});

test('keeps the full log of the queue as a setting that a reload keeps', async ({ page }) => {
  await page.goto(`${URL_BASE}/settings#logs`);
  const name = 'Keep the full log of every target in the queue';
  const keep = page.getByRole('main').getByRole('switch', { name });
  try {
    await expect(keep).toBeChecked();

    await keep.click();
    await expect(keep).not.toBeChecked();

    // The setting is saved on the server, so a reload shows it still off.
    await page.reload();
    await expect(page.getByRole('main').getByRole('switch', { name })).not.toBeChecked();
    expect((await stack.call('GET', '/settings')).body.settings.keepQueueLogs).toBe(false);
  } finally {
    // The tests that follow start from the default again.
    await stack.call('PATCH', '/settings', { keepQueueLogs: true });
  }
});
