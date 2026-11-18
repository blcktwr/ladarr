import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
});
test.afterAll(() => stack.stop());

test('counts down six seconds after an update, then reloads the page', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  // The update is installed without a real server, so the page keeps the answer.
  await page.route('**/api/system/update', (route) => {
    const post = route.request().method() === 'POST';
    return route.fulfill({
      status: post ? 202 : 200,
      contentType: 'application/json',
      body: JSON.stringify(post ? { version: '9.9.9' } : { available: true, latest: '9.9.9', url: 'https://example.com', notes: null }),
    });
  });

  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('button', { name: 'Check updates', exact: true }).click();
  await page.getByRole('button', { name: 'Install update', exact: true }).click();
  await expect(page.getByText(/Version 9\.9\.9 installed, the server will restart in \ds\.\.\./)).toBeVisible();

  const reloaded = page.waitForEvent('load', { timeout: 15_000 });
  await reloaded;
  await expect(page.getByRole('button', { name: 'Check updates', exact: true })).toBeVisible();
  await expect(page.getByText(/restart in/)).toHaveCount(0);
});
