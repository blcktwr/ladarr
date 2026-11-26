import type { LogEntry, LogsResponse } from '@ladarr/shared/types';
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
  const firstKey = 'movie:2';
  const secondKey = 'tv:1';
  const added = (entry: LogEntry, key: string) => entry.type === 'catalog' && entry.event === 'added' && entry.titleKey === key;
  const first = await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'paused', preset: 'p1080' });
  expect(first.status).toBe(201);
  const initial = await stack.call('GET', `/system/logs?limit=1000&kind=logs&itemId=${firstKey}`);
  const entry = (initial.body as LogsResponse).entries.find((entry) => added(entry, firstKey))!;
  expect(entry).toBeDefined();

  await page.goto(`${URL_BASE}/settings#logs`);
  const main = page.getByRole('main');
  await main.getByRole('switch', { name: 'Live' }).click();
  const details = `Details of ${entry.message}`;
  const opened = main.getByRole('button', { name: details, exact: true });
  await expect(opened).toBeVisible();

  // The entry opens in a side panel.
  await opened.click();
  const panel = page.getByRole('dialog', { name: details, exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(firstKey);

  // A new entry arrives, and the panel keeps the entry that it showed.
  const live = page.waitForResponse(async (response) =>
    response.url().endsWith('/system/logs?limit=1000&kind=logs') && response.ok() &&
    ((await response.json()) as LogsResponse).entries.some((entry) => added(entry, secondKey)),
  );
  const second = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'paused', preset: 'p2160' });
  expect(second.status).toBe(201);
  const updated = ((await (await live).json()) as LogsResponse).entries.find((entry) => added(entry, secondKey))!;
  expect(updated.message).not.toBe(entry.message);
  await expect(page.locator('main').getByText(updated.message, { exact: true })).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(firstKey);
  await expect(panel).not.toContainText(secondKey);
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
