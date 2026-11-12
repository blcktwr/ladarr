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

  // The genre of the filter panel reaches both lists.
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByRole('combobox', { name: 'Genre' }).click();
  await page.getByRole('option', { name: 'Action' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(main.getByRole('link', { name: /Action Movie 2001/ })).toBeVisible();

  // The country filters the services of the list.
  await page.getByRole('button', { name: 'Filters' }).click();
  const country = page.getByRole('combobox', { name: 'Country' });
  await country.click();
  await page.getByRole('option', { name: 'Spain' }).click();
  await expect(country).toContainText('Spain');
  await page.getByRole('button', { name: 'Close' }).click();

  // A streaming service of the country filters the lists too.
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByRole('combobox', { name: 'Genre' }).click();
  await page.getByRole('option', { name: 'All genres' }).click();
  const netflix = page.getByRole('button', { name: 'Netflix' });
  await netflix.click();
  await expect(netflix).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(main.getByRole('link', { name: /Streaming Movie 2002/ })).toBeVisible();

  // The poster of a title that is not in the catalog opens its page.
  await main.getByRole('link', { name: /Movie Name 2019/ }).first().click();
  await expect(page).toHaveURL(/\/catalog\/movie\/2$/);
  await expect(main.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Add', exact: true }).first()).toBeVisible();
});
