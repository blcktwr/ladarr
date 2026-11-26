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

test('filters a global search in Discovery and keeps the filter when the query changes', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/catalog`);
  const search = page.getByRole('searchbox', { name: 'Search', exact: true });
  await search.fill('Name');
  await expect(page).toHaveURL(/\/discovery\?q=Name$/);
  const main = page.getByRole('main');
  const movie = main.getByRole('link', { name: /Movie Name/ });
  const show = main.getByRole('link', { name: /Show Name/ });
  await expect(movie).toBeVisible();
  await expect(show).toBeVisible();
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByRole('combobox', { name: 'Genre' }).click();
  await page.getByRole('option', { name: 'Comedy', exact: true }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(movie).toHaveCount(0);
  await expect(show).toBeVisible();
  await expect(search).toHaveValue('Name');

  await search.fill('Movie');
  await search.press('Enter');
  await expect(main.getByText('No titles match.', { exact: true })).toBeVisible();
  await expect(movie).toHaveCount(0);
  await expect(show).toHaveCount(0);
});

test('filters search results by TMDB rating and keeps both bounds on reload', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/discovery?q=Name&ratingMin=7.5&ratingMax=8.1`);
  const main = page.getByRole('main');
  const movie = main.getByRole('link', { name: /Movie Name/ });
  const show = main.getByRole('link', { name: /Show Name/ });
  const empty = main.getByText('No titles match.', { exact: true });
  const filters = page.getByRole('button', { name: 'Filters' });
  const close = page.getByRole('button', { name: 'Close' });
  const min = page.getByRole('slider', { name: 'Minimum TMDB rating', exact: true });
  const max = page.getByRole('slider', { name: 'Maximum TMDB rating', exact: true });
  await expect(movie).toBeVisible();
  await expect(show).toBeVisible();

  await filters.click();
  await min.press('ArrowRight');
  await expect(page).toHaveURL((url) => url.searchParams.get('ratingMin') === '7.6');
  await close.click();
  await expect(show).toBeVisible();
  await expect(movie).toHaveCount(0);

  await filters.click();
  await max.press('ArrowLeft');
  await expect(page).toHaveURL((url) => Number(url.searchParams.get('ratingMax')) === 8);
  await close.click();
  await expect(empty).toBeVisible();

  await page.reload();
  await expect(empty).toBeVisible();
  await filters.click();
  await expect(min).toHaveAttribute('aria-valuenow', '7.6');
  await expect(max).toHaveAttribute('aria-valuenow', '8');
  await min.press('Home');
  await expect(page).toHaveURL((url) => !url.searchParams.has('ratingMin') && Number(url.searchParams.get('ratingMax')) === 8);
  await max.press('End');
  await expect(page).toHaveURL(/\/discovery\?q=Name$/);
  await close.click();
  await expect(movie).toBeVisible();
  await expect(show).toBeVisible();
});

test('drags TMDB ratings to the track ends and shows values on opposite sides', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/discovery?q=Name&ratingMin=2.5&ratingMax=7.5`);
  await page.getByRole('button', { name: 'Filters' }).click();

  const min = page.getByRole('slider', { name: 'Minimum TMDB rating', exact: true });
  const max = page.getByRole('slider', { name: 'Maximum TMDB rating', exact: true });
  const minThumb = min.locator('..');
  const maxThumb = max.locator('..');
  const track = minThumb.locator('..');

  const start = (await track.boundingBox())!;
  const minLabel = (await minThumb.getByText('2.5', { exact: true }).boundingBox())!;
  const maxLabel = (await maxThumb.getByText('7.5', { exact: true }).boundingBox())!;
  expect.soft(minLabel.y + minLabel.height).toBeLessThan(start.y);
  expect.soft(maxLabel.y).toBeGreaterThan(start.y + start.height);

  const dragToEdge = async (thumb: typeof minThumb, edge: 'left' | 'right') => {
    const handle = (await thumb.boundingBox())!;
    const rail = (await track.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(edge === 'left' ? rail.x : rail.x + rail.width, rail.y + rail.height / 2, { steps: 10 });
    await page.mouse.up();
  };

  await dragToEdge(minThumb, 'left');
  await expect(min).toHaveAttribute('aria-valuenow', '0');
  await expect(page).toHaveURL((url) => !url.searchParams.has('ratingMin') && url.searchParams.get('ratingMax') === '7.5');

  await dragToEdge(maxThumb, 'right');
  await expect(max).toHaveAttribute('aria-valuenow', '10');
  await expect(page).toHaveURL(/\/discovery\?q=Name$/);

  const [rail, left, right] = await Promise.all([track.boundingBox(), minThumb.boundingBox(), maxThumb.boundingBox()]);
  expect.soft(Math.abs(left!.x + left!.width / 2 - rail!.x), 'Minimum thumb center meets the left edge').toBeLessThanOrEqual(1);
  expect.soft(Math.abs(right!.x + right!.width / 2 - (rail!.x + rail!.width)), 'Maximum thumb center meets the right edge').toBeLessThanOrEqual(1);
});

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

  // The end of the page takes the next page of the movies, with its titles at the end of the list, and a title that
  // two pages share shows once.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(main.getByRole('link', { name: /Bench Movie Alpha/ })).toBeVisible();
  const order = await main.getByRole('link').allTextContents();
  expect(order.findIndex((text) => text.includes('Bench Movie Alpha'))).toBeGreaterThan(order.findIndex((text) => text.includes('Show Name')));
  await expect(main.getByRole('link', { name: /Movie Name/ })).toHaveCount(1);

  // The sort reads the lists again from the first page.
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: 'TMDB rating (desc)' }).click();
  await expect(main.getByRole('link', { name: /Bench Movie Bravo/ })).toBeVisible();

  // The genre of the filter panel reaches both lists.
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByRole('combobox', { name: 'Genre' }).click();
  await page.getByRole('option', { name: 'Action' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(main.getByRole('link', { name: /Action Movie/ })).toBeVisible();

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

  // The search of the panel finds a service by its name.
  const search = page.getByRole('searchbox', { name: 'Search services' });
  await search.fill('Net');
  await expect(netflix).toBeVisible();
  await search.fill('Hulu');
  await expect(netflix).toBeHidden();
  await search.fill('');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(main.getByRole('link', { name: /Streaming Movie/ })).toBeVisible();

  // The poster of a title that is not in the catalog opens its page.
  await main.getByRole('link', { name: /Movie Name/ }).first().click();
  await expect(page).toHaveURL(/\/catalog\/movie\/2$/);
  await expect(main.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Add', exact: true }).first()).toBeVisible();

  // The section menu keeps Discovery selected on the page of the title.
  await expect(links.nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(links.nth(1)).not.toHaveAttribute('aria-current', 'page');
});
