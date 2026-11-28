import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack, { client: false });
});
test.afterAll(() => stack.stop());

test('the General tab saves the time zone', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/settings`);
  const language = page.getByRole('combobox', { name: 'Language', exact: true });
  const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
  const zone = page.getByRole('combobox', { name: 'Time zone', exact: true });
  // The innermost block that holds the language and the theme holds the time zone too.
  const group = page.locator('div').filter({ has: language }).filter({ has: theme }).last();
  await expect(group.getByRole('combobox', { name: 'Time zone', exact: true })).toBeVisible();
  await expect(zone).toHaveValue('UTC');

  for (const name of ['Asia/Tokyo', 'UTC']) {
    // The typed text filters the list.
    await zone.click();
    await zone.fill(name);
    await page.getByRole('option', { name, exact: true }).click();
    await expect.poll(async () => (await stack.call('GET', '/settings')).body.settings.timeZone).toBe(name);
    await page.reload();
    await expect(zone).toHaveValue(name);
  }
});
