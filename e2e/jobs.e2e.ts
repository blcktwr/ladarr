import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';
import type { QueueJob } from '@ladarr/shared/types';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const titleKey = 'movie:2';
async function jobs(): Promise<QueueJob[]> {
  return (await stack.call('GET', '/queue/jobs')).body.items;
}
const movieSearch = (job: QueueJob) => job.type === 'queue.search' && job.state === 'waiting' && (job.payload as { titleKey?: string } | null)?.titleKey === titleKey;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The queue is paused, so the search of the new title waits for the worker and the page has a job to show.
  const paused = await stack.call('POST', '/queue/pause', { paused: true });
  if (paused.status >= 300) throw new Error(`POST /queue/pause answered ${paused.status}: ${JSON.stringify(paused.body)}`);
  const added = await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
  await expect.poll(async () => (await jobs()).some(movieSearch), { timeout: 60_000 }).toBe(true);
});
test.afterAll(() => stack.stop());

test('shows an item job with its time, its payload, and its actions', async ({ page, context }) => {
  const job = (await jobs()).find(movieSearch)!;
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/activity`);
  await page.getByRole('button', { name: 'Jobs in the queue', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Jobs in the queue' });
  const table = panel.getByRole('table', { name: 'Jobs in the queue' });
  const row = table.locator(`tr[data-row="${job.id}"]`);
  await expect(row).toContainText('Search Movie Name (2019)');
  await expect(row).toContainText('Runs now');

  // The payload stays closed until a click on the row.
  await expect(panel.getByText('titleKey')).toHaveCount(0);
  await row.click();
  const field = panel.locator('.variable-row').filter({ has: page.getByText('titleKey', { exact: true }) });
  await expect(field.getByText(`"${titleKey}"`, { exact: true })).toBeVisible();

  // Run now makes the job the next one to run.
  const run = row.getByRole('button', { name: 'Run Search Movie Name (2019) now' });
  await expect(run).toBeVisible();
  const clickedAt = Date.now();
  expect(job.runAt).toBeLessThan(clickedAt);
  await run.click();
  await expect.poll(async () => (await jobs()).find(({ id }) => id === job.id)?.runAt).toBeGreaterThanOrEqual(clickedAt);
  expect((await jobs()).find(({ id }) => id === job.id)?.runAt).toBeLessThanOrEqual(Date.now());

  // Delete takes the job out of the queue.
  await row.getByRole('button', { name: 'Delete Search Movie Name (2019) from the queue' }).click();
  await expect.poll(jobs).toEqual([]);
  await expect(panel.getByText('No job is in the queue.')).toBeVisible();
});
