import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The queue is paused, so the search of the new title waits for the worker and the page has a job to show.
  const paused = await stack.call('POST', '/queue/pause', { paused: true });
  if (paused.status >= 300) throw new Error(`POST /queue/pause answered ${paused.status}: ${JSON.stringify(paused.body)}`);
  const added = await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
  await expect.poll(async () => (await stack.call('GET', '/queue/jobs')).body.items.length, { timeout: 60_000 }).toBeGreaterThan(0);
});
test.afterAll(() => stack.stop());

test('shows an item job with its time, its payload, and its actions', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/activity`);
  await page.getByRole('button', { name: 'Jobs in the queue' }).click();
  const panel = page.getByRole('dialog', { name: 'Jobs in the queue' });
  const table = panel.getByRole('table', { name: 'Jobs in the queue' });
  const row = table.locator('tr[data-row]').filter({ hasText: 'Search Movie Name (2019)' });
  await expect(row).toContainText('Runs now');

  // The payload stays closed until a click on the row.
  await expect(panel.getByText('titleKey')).toHaveCount(0);
  await row.click();
  await expect(panel.getByText('titleKey')).toBeVisible();

  // Run now makes the job the next one to run.
  const run = row.getByRole('button', { name: 'Run Search Movie Name (2019) now' });
  await expect(run).toBeVisible();
  await run.click();
  await expect.poll(async () => (await stack.call('GET', '/queue/jobs')).body.items[0].runAt).toBeLessThanOrEqual(Date.now());

  // Delete takes the job out of the queue.
  await panel.getByRole('button', { name: 'Delete Search Movie Name (2019) from the queue' }).click();
  await expect.poll(async () => (await stack.call('GET', '/queue/jobs')).body.items.length).toBe(0);
  await expect(panel.getByText('No job is in the queue.')).toBeVisible();
});
