import { expect, test } from './fixtures.ts';
import { startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  for (const [method, path, body] of [
    ['POST', '/roots', { path: stack.folders.movies, mediaType: 'movie' }],
    ['POST', '/roots', { path: stack.folders.tv, mediaType: 'tv' }],
    ['POST', '/settings/complete-setup', {}],
  ] as const) {
    const res = await stack.call(method, path, body);
    if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
});
test.afterAll(() => stack.stop());

test('the Discovery item opens the page with a row for each list', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/catalog`);

  // Discovery is at the left of the catalog.
  const links = page.getByRole('navigation', { name: 'Sections' }).getByRole('link');
  await expect(links.nth(0)).toHaveAccessibleName('Discovery');
  await expect(links.nth(1)).toHaveAccessibleName('Catalog');
  await links.nth(0).click();
  await expect(page).toHaveURL(/\/discovery$/);

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Discovery', exact: true })).toBeVisible();

  // The end of the page takes the next page of the movies.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(main.getByRole('link', { name: /Bench Movie Alpha/ })).toBeVisible();

  // The sort reads the lists again from the first page.
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: 'TMDB rating (desc)' }).click();
  await expect(main.getByRole('link', { name: /Bench Movie Bravo/ })).toBeVisible();

  // The poster of a title that is not in the catalog opens its page.
  await main.getByRole('link', { name: /Movie Name 2019/ }).first().click();
  await expect(page).toHaveURL(/\/catalog\/movie\/2$/);
  await expect(main.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Add', exact: true }).first()).toBeVisible();
});
