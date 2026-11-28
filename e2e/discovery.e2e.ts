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

test('opens the actor profile from the photo in global search results', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.route('**/actor-one.jpg', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
  await page.goto(`${URL_BASE}/catalog`);
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('Actor One');

  const main = page.getByRole('main');
  const actor = main.getByRole('link', { name: 'Actor One', exact: true });
  await expect(actor.getByText('Actor One', { exact: true })).toBeVisible();
  const photo = actor.locator('img[src$="/actor-one.jpg"]');
  await expect(photo).toBeVisible();
  await expect(actor.getByRole('checkbox')).toHaveCount(0);
  await expect(actor.getByRole('button')).toHaveCount(0);
  // The search finds no title, so only the person shows.
  await expect(main.getByRole('link')).toHaveCount(1);
  await expect(main.getByText('No titles match.', { exact: true })).toHaveCount(0);
  await photo.click();
  await expect(page).toHaveURL(/\/catalog\/person\/11$/);
  await expect(main.getByRole('heading', { name: 'Actor One', exact: true })).toBeVisible();
});

test('shows the people of a search as small round photos above the titles', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.route('**/actor-one.jpg', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' }));
  // The fake TMDB answers this query with a person and with titles.
  await page.goto(`${URL_BASE}/discovery?q=o`);

  const main = page.getByRole('main');
  const actor = main.getByRole('link', { name: 'Actor One', exact: true });
  const photo = actor.locator('img[src$="/actor-one.jpg"]');
  const movie = main.getByRole('link', { name: /Movie Name/ });
  const show = main.getByRole('link', { name: /Show Name/ });
  await expect(photo).toBeVisible();
  await expect(movie).toBeVisible();
  await expect(show).toBeVisible();
  await expect(actor).toHaveAttribute('href', '/catalog/person/11');
  await expect(main.getByRole('heading')).toHaveText(['Discovery']);

  const person = (await actor.boundingBox())!;
  for (const title of [movie, show]) {
    expect.soft(person.y + person.height, 'The person is above the title').toBeLessThanOrEqual((await title.boundingBox())!.y);
  }

  const face = (await photo.boundingBox())!;
  const name = (await actor.getByText('Actor One', { exact: true }).boundingBox())!;
  const poster = (await movie.locator('img').first().boundingBox())!;
  expect.soft(name.y, 'The name is under the photo').toBeGreaterThanOrEqual(face.y + face.height);
  expect.soft(face.width, 'The photo is narrower than a poster').toBeLessThan(poster.width);
  expect.soft(face.height, 'The photo is shorter than a poster').toBeLessThan(poster.height);
  expect.soft(Math.abs(face.width - face.height), 'The photo is as wide as it is high').toBeLessThanOrEqual(1);
  // A round photo takes the pointer at its center, and not at the corners of its box.
  await expect.soft.poll(() => photo.evaluate((image) => {
    const { left, right, top, bottom } = image.getBoundingClientRect();
    const hits = (x: number, y: number) => document.elementsFromPoint(x, y).includes(image);
    return {
      center: hits((left + right) / 2, (top + bottom) / 2),
      corners: [hits(left + 2, top + 2), hits(right - 2, top + 2), hits(left + 2, bottom - 2), hits(right - 2, bottom - 2)],
    };
  })).toEqual({ center: true, corners: [false, false, false, false] });

  await photo.click();
  await expect(page).toHaveURL(/\/catalog\/person\/11$/);
});

test('a search with no people leaves no room for them above the titles', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  const main = page.getByRole('main');
  const poster = main.getByRole('link', { name: /Movie Name/ }).locator('img').first();

  // The lists without a search never have people, so their first poster gives the place of the titles.
  await page.goto(`${URL_BASE}/discovery`);
  await expect(poster).toBeVisible();
  const start = (await poster.boundingBox())!.y;

  await page.goto(`${URL_BASE}/discovery?q=Movie`);
  await expect(main.getByRole('link')).toHaveCount(1);
  await expect(poster).toBeVisible();
  expect((await poster.boundingBox())!.y).toBe(start);
});

test('shows the people of a search in one row, as many as fit in the column of the heading', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  // The fake TMDB has one person, so this test puts more of them in the answer. Their names go down, so a sort shows.
  const names = Array.from({ length: 20 }, (_, index) => `Person ${40 - index}`);
  await page.route(/\/api\/discovery\?/, async (route) => {
    const response = await route.fetch();
    const people = names.map((name, index) => ({ id: 100 + index, name, profilePath: null }));
    await route.fulfill({ response, json: { ...(await response.json()), people } });
  });
  await page.goto(`${URL_BASE}/discovery?q=o`);

  const main = page.getByRole('main');
  const heading = main.getByRole('heading', { name: 'Discovery', exact: true });
  await expect(main.getByRole('link', { name: names[0], exact: true })).toBeVisible();
  const browser = await context.newCDPSession(page);

  // The people on the screen: the ones that show at the left, the center, or the right of their box.
  const seen = () => main.evaluate((root) => [...root.querySelectorAll('a[href^="/catalog/person/"]')].flatMap((link) => {
    const { x, y, width, height, right } = link.getBoundingClientRect();
    const shows = link.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      [x + 2, x + width / 2, right - 2].some((point) => document.elementsFromPoint(point, y + height / 2).includes(link));
    return shows ? [{ name: link.textContent!, x, y, width, right }] : [];
  }));
  // The people in the accessibility tree of the browser, which a screen reader reads.
  const read = async () => {
    const { nodes } = await browser.send('Accessibility.getFullAXTree');
    const found = nodes.filter((node) => !node.ignored).map((node) => String(node.name?.value));
    return [...new Set(found.filter((name) => /^Person \d+$/.test(name)))].sort();
  };
  // What the Tab key reaches between the controls of the header and the first title.
  const tabbed = async () => {
    const reached: string[] = [];
    await page.getByRole('button', { name: 'Filters' }).focus();
    for (let step = 0; step <= names.length; step++) {
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => ({ href: document.activeElement?.getAttribute('href') ?? '', text: document.activeElement?.textContent ?? '' }));
      if (/^\/catalog\/(movie|tv)\//.test(focus.href)) break;
      reached.push(focus.text);
    }
    return reached;
  };

  const counts: number[] = [];
  for (const size of [{ width: 1280, height: 900 }, { width: 500, height: 900 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => window.scrollTo(0, 0));
    const at = `at a width of ${size.width}`;
    await expect.soft.poll(async () => {
      const row = await seen();
      const left = (await heading.boundingBox())!.x;
      // The column is at the center of the page, so its two edges are as far from the edges of the window.
      const end = await page.evaluate(() => document.documentElement.clientWidth) - left;
      const [first, second] = row;
      const last = row.at(-1);
      if (!first || !second || !last) return row;
      return {
        oneRow: row.every((person) => person.y === first.y),
        searchOrder: row.every((person, index) => person.name === names[index]),
        atHeadingEdge: Math.abs(first.x - left) <= 1,
        insideColumn: last.right <= end + 1,
        noRoomForOneMore: last.right + (second.x - first.right) + last.width > end,
      };
    }, `The people ${at}`).toEqual({ oneRow: true, searchOrder: true, atHeadingEdge: true, insideColumn: true, noRoomForOneMore: true });

    const shown = (await seen()).map((person) => person.name);
    counts.push(shown.length);
    await expect.soft.poll(read, `A screen reader reads only the people on the screen ${at}`).toEqual([...shown].sort());
    expect.soft(await tabbed(), `The Tab key reaches only the people on the screen ${at}`).toEqual(shown);

    await expect.soft(main.getByRole('button', { name: /more/i })).toHaveCount(0);
    await expect.soft(main.getByText(/more/i)).toHaveCount(0);
    for (const name of [/Movie Name/, /Show Name/, /Two Seasons/]) {
      const poster = (await main.getByRole('link', { name }).locator('img').first().boundingBox())!;
      expect.soft([poster.width, poster.height], `The size of a poster ${at}`).toEqual([160, 240]);
    }
  }
  expect.soft(counts[1], 'A narrow window shows fewer people').toBeLessThan(counts[0]!);
});

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
