import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.describe.configure({ mode: 'serial' });
// The time of the setup in beforeAll counts for the first test.
test.setTimeout(180_000);
test.use({ actionTimeout: 15_000 });

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // A paused title has no search of its own, so nothing downloads while the tests run.
  for (const [method, path, body] of [
    ['POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'paused' }],
    ['PUT', '/quality/profiles/p1080', { name: '1080p', items: [['webdl-1080'], ['webrip-1080'], ['bluray-1080']] }],
  ] as const) {
      const res = await stack.call(method, path, body);
      if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('a search on the selected titles', async ({ page }) => {
  await page.goto(URL_BASE);
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
  // The catalog shows no state badge for a title that is not available.
  await expect(page.getByRole('main').getByText(/^(Waiting for release|Missing)$/)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Show Name' }).click();
  // The title has no episode to search, so the answer is a message.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Search the selected titles' });
  await expect(dialog).toContainText('Nothing needs a search now');
  await dialog.getByText('Close', { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Only Search and Remove are left.
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  for (const name of ['Pause', 'Resume', 'Refresh metadata', 'Set quality', 'Clear selection']) await expect(page.getByRole('button', { name })).toHaveCount(0);
});

test('a file that is not a backup is refused and nothing changes', async ({ page }) => {
  await page.goto(URL_BASE);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'System' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Restore from file' }).click();
  await (await chooser).setFiles({ name: 'not-a-backup.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip file') });

  const dialog = page.getByRole('dialog', { name: 'Restore this backup?' });
  await expect(dialog).toContainText('the file not-a-backup.zip');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('The file is not a backup of this app.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  // The session is still valid, and the title is still in the library.
  await page.reload();
  await page.getByRole('link', { name: 'Catalog', exact: true }).click();
  await expect(page.getByRole('main').getByRole('link', { name: /Show Name/ })).toBeVisible();
});

test('Add on a title that is not in the catalog adds it', async ({ page }) => {
  await page.goto(`${URL_BASE}/search?q=Movie`);
  // The posters have no button that adds a title.
  await expect(page.getByRole('button', { name: /^Add / })).toHaveCount(0);
  await page.getByRole('link', { name: /Movie Name 2019 Movies$/ }).getByText('Movie Name', { exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/movie\/2$/);
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  expect((await stack.call('GET', '/library/movie:2')).body.title.presetOverride).toBeNull();
});

test('the catalog shows the type of a title on its poster', async ({ page }) => {
  await page.goto(URL_BASE);
  const movie = page.getByRole('main').getByRole('link', { name: 'Movie Name 2019 Movies', exact: true });
  const show = page.getByRole('main').getByRole('link', { name: 'Show Name 2020 Series', exact: true });
  await expect(movie).toBeVisible();
  await expect(show).toBeVisible();
  await expect(movie).toContainText('Movies');
  await expect(show).toContainText('Series');
  // The poster shows no availability badge.
  await expect(movie).not.toContainText('Available');
  await expect(show).not.toContainText('Available');
  // The row of posters starts at the left edge of the centered catalog column.
  const columnBox = (await page.getByRole('heading', { name: 'Catalog' }).boundingBox())!;
  const boxes = [(await movie.boundingBox())!, (await show.boundingBox())!].sort((a, b) => a.x - b.x);
  expect(Math.abs(boxes[0]!.x - columnBox.x)).toBeLessThanOrEqual(2);
  const patched = await stack.call('PATCH', '/library/tv:1', { seriesType: 'anime' });
  if (patched.status >= 300) throw new Error(`PATCH /library/tv:1 answered ${patched.status}: ${JSON.stringify(patched.body)}`);
  try {
    await page.reload();
    const anime = page.getByRole('main').getByRole('link', { name: 'Show Name 2020 Anime', exact: true });
    await expect(anime).toBeVisible();
  } finally {
    const restored = await stack.call('PATCH', '/library/tv:1', { seriesType: 'standard' });
    if (restored.status >= 300) throw new Error(`PATCH /library/tv:1 answered ${restored.status}: ${JSON.stringify(restored.body)}`);
  }
});

test('Search results can be selected, many at once, and a new search clears the selection', async ({ page }) => {
  await page.goto(`${URL_BASE}/search?q=Name`);
  const movie = page.getByRole('checkbox', { name: 'Movie Name', exact: true });
  const show = page.getByRole('checkbox', { name: 'Show Name', exact: true });
  await movie.click();
  await show.click();
  await expect(movie).toBeChecked();
  await expect(show).toBeChecked();
  await show.click();
  await expect(movie).toBeChecked();
  await expect(show).not.toBeChecked();
  await page.getByRole('searchbox', { name: 'Search' }).fill('Movie');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/q=Movie$/);
  await expect(movie).not.toBeChecked();
});

test('a search starts while the person types, without Enter', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog`);
  await page.getByRole('searchbox', { name: 'Search' }).fill('Movie');
  await expect(page).toHaveURL(/\/search\?q=Movie$/);
  await expect(page.getByRole('checkbox', { name: 'Movie Name', exact: true })).toBeVisible();
});

test('the page of a title shows the TMDB score, the cast, and the recommendations', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog/movie/2`);
  await expect(page.getByText('TMDB 7.5')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cast' })).toBeVisible();
  await expect(page.getByText('Actor One')).toBeVisible();
  await expect(page.getByText('Role One')).toBeVisible();
  // A recommended title that is not in the catalog opens the same page, with a button that searches for it.
  await page.getByRole('link', { name: /Bench Movie Alpha/ }).getByText('Bench Movie Alpha', { exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/movie\/900001$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Bench Movie Alpha (2019)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // The page stays at the same address, and it shows the actions of a title that is in the catalog now.
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/catalog\/movie\/900001$/);
  // A series with no cast and no recommendations has neither section.
  await page.goto(`${URL_BASE}/catalog/tv/1`);
  await expect(page.getByRole('heading', { name: 'Show Name (2020)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cast' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Recommendations' })).toHaveCount(0);
});

test('a title that has no file has Search, and a title that has a file has Upgrade', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog/tv/1`);
  await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upgrade', exact: true })).toHaveCount(0);
  // The title is paused, so a search has nothing to start.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('alert').getByText('Nothing needs a search now')).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  const alert = page.getByRole('alertdialog', { name: 'Remove 1 title?' });
  await expect(alert).toBeVisible();
  // The alert has the switch and the two buttons. The switch makes no request, so the button does not change.
  const plans: string[] = [];
  page.on('request', (request) => request.url().includes('/library/plans') && plans.push(request.url()));
  await alert.getByRole('switch', { name: 'Delete the files too' }).click();
  await expect(alert.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
  await expect(alert.getByRole('button')).toHaveText(['Cancel', 'Remove']);
  expect(plans).toEqual([]);
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toHaveCount(0);

  // The movie has a file, as the server sends it.
  await page.route(/\/library\/movie:2$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.title.availability = 'available';
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/library\/movie:2\/upgrades$/, (route) => route.fulfill({ json: { resolutions: [1080, 2160] } }));
  await page.goto(`${URL_BASE}/catalog/movie/2`);
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
  // Upgrade asks for a resolution first, then for a plan of the title.
  await page.getByRole('button', { name: 'Upgrade', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Search for upgrades' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Resolution' }).click();
  await page.getByRole('option', { name: '1080p' }).click();
  const preview = page.waitForRequest((request) => request.url().endsWith('/library/search/preview') && request.postData()?.includes('"upgrades"') === true);
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await preview;
});

test('Remove asks in an alert, and the page stays open as a title that is not in the catalog', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog/movie/900001`);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  const alert = page.getByRole('alertdialog', { name: 'Remove 1 title?' });
  await expect(alert.getByRole('switch', { name: 'Delete the files too' })).toBeVisible();
  await alert.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Bench Movie Alpha removed from the library')).toBeVisible();
  await expect(page).toHaveURL(/\/catalog\/movie\/900001$/);
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
});

test('removing a series tells the person that it is out of the library', async ({ page }) => {
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 3, add: 'paused' });
  expect(added.status).toBe(201);
  await page.goto(`${URL_BASE}/catalog/tv/3`);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Remove 1 title?' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Two Seasons removed from the library')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Add/ })).toBeVisible();
});

test('an actor opens a page with the movies and the series of the actor', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog/movie/2`);
  await page.getByRole('link', { name: /Actor One/ }).click();
  await expect(page).toHaveURL(/\/catalog\/person\/11$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Actor One' })).toBeVisible();
  await expect(page.getByText('Also known as: Actor 1, Primer Actor')).toBeVisible();
  await expect(page.getByText('Popularity 12.3')).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /Movie Name/ })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /Show Name/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Add / })).toHaveCount(0);
  await page.getByRole('main').getByRole('link', { name: /Show Name/ }).getByText('Show Name', { exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/tv\/1$/);
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
});

test('the back button of a page opens the page before it, or the catalog', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog/movie/2`);
  await page.getByRole('link', { name: /Actor One/ }).click();
  await expect(page).toHaveURL(/\/catalog\/person\/11$/);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/movie\/2$/);
  // The page that the user opens first has no page before it.
  await page.goto(`${URL_BASE}/catalog/person/11`);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/catalog$/);
});

test('the background reaches the end of a page that is taller than the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto(`${URL_BASE}/catalog/movie/2`);
  await expect(page.getByRole('heading', { name: 'Recommendations' })).toBeVisible();
  // The bottom margin of the last section must stay inside the background, or the page ends with a white band.
  const band = await page.evaluate(() => document.documentElement.scrollHeight - (document.querySelector('main')!.parentElement!.getBoundingClientRect().bottom + scrollY));
  expect(band).toBeLessThan(1);
  // The page under the background is not white, so a scroll past the end or a slow paint shows no flash.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(4, 4, 4)');
});

test('a profile that the user makes ranks the qualities in the order of the clicks', async ({ page }) => {
  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('tab', { name: 'Quality' }).click();
  await page.getByRole('button', { name: 'Add profile' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a profile' });
  await dialog.getByLabel('Name').fill('Ordered');
  await dialog.getByRole('checkbox', { name: 'WEBRip 1080p', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'WEB-DL 1080p', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Ordered' })).toBeVisible();
  const { profiles } = (await stack.call('GET', '/quality')).body;
  expect(profiles.find((profile: { name: string }) => profile.name === 'Ordered')).toMatchObject({ items: [['webrip-1080'], ['webdl-1080']] });
});

test('the quality profiles are an ordered priority chain', async ({ page }) => {
  // Earlier tests add profiles, and the list is serial. The built-in profiles are the list for this test.
  const { profiles } = (await stack.call('GET', '/quality')).body;
  for (const profile of profiles as { id: string }[]) {
    if (profile.id !== 'p1080' && profile.id !== 'p2160') await stack.call('DELETE', `/quality/profiles/${profile.id}`);
  }
  await stack.call('PUT', '/quality/order', { ids: ['p1080', 'p2160'] });

  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('tab', { name: 'Quality' }).click();
  const qualities = page.getByRole('region', { name: 'Qualities' });
  // A profile is no longer the default one: the first row of the chain is the one that the search uses first.
  await expect(qualities.getByText('Default', { exact: true })).toHaveCount(0);
  const row = (name: string) => qualities.getByRole('row').filter({ hasText: name });
  const moveUp = (name: string) => qualities.getByRole('button', { name: `Move ${name} up` });
  const moveDown = (name: string) => qualities.getByRole('button', { name: `Move ${name} down` });

  await moveUp('2160p').click();
  await expect.poll(async () => (await stack.call('GET', '/quality')).body.profiles[0].id).toBe('p2160');
  await expect(row('2160p')).not.toContainText('Default');
  await expect(qualities.getByText('Default', { exact: true })).toHaveCount(0);

  await moveDown('2160p').click();
  await expect.poll(async () => (await stack.call('GET', '/quality')).body.profiles.map((profile: { id: string }) => profile.id)).toEqual(['p1080', 'p2160']);

  await expect(moveUp('1080p')).toBeDisabled();
  await expect(moveDown('2160p')).toBeDisabled();
});

test('the General tab changes the language of the interface', async ({ page }) => {
  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: 'Español' }).click();
  await expect(page.getByRole('link', { name: 'Calendario' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Calendario' })).toBeVisible();
  expect((await stack.call('GET', '/settings')).body.settings.language).toBe('es');
  await page.getByRole('combobox', { name: 'Idioma', exact: true }).click();
  await page.getByRole('option', { name: 'English' }).click();
  await expect(page.getByRole('link', { name: 'Calendar' })).toBeVisible();
  expect((await stack.call('GET', '/settings')).body.settings.language).toBe('en');
});

test('the Search button on a result shows on hover and searches the title', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog/movie/2`);
  const result = page.getByRole('main').getByRole('link', { name: /Bench Movie Alpha/ });
  const button = result.getByRole('button', { name: 'Search Bench Movie Alpha' });
  const scrim = button.locator('..');
  // The pointer is away from the poster, so the button hides.
  await page.mouse.move(0, 0);
  expect(await scrim.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await result.hover();
  await expect.poll(() => scrim.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  // The title is not in the catalog, so the button adds it and starts the search. The page stays as it is.
  await button.click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Added to the queue')).toBeVisible();
  await expect(page).toHaveURL(/\/catalog\/movie\/2$/);
  expect((await stack.call('GET', '/library/movie:900001')).status).toBe(200);
});

test('the General tab changes the theme of the interface', async ({ page }) => {
  const html = page.locator('html');
  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('combobox', { name: 'Theme', exact: true }).click();
  await page.getByRole('option', { name: 'Light' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  expect((await stack.call('GET', '/settings')).body.settings.theme).toBe('light');
  await page.getByRole('combobox', { name: 'Theme', exact: true }).click();
  await page.getByRole('option', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect((await stack.call('GET', '/settings')).body.settings.theme).toBe('dark');
});
