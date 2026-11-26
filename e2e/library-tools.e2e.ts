import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.describe.configure({ mode: 'serial' });
// The time of the setup in beforeAll counts for the first test.
test.setTimeout(180_000);
test.use({ actionTimeout: 15_000 });

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const titleAdd = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Add', exact: true }).and(page.locator('button:not(a button)'));
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

test('an imported episode without a linked file does not show as searching', async ({ page }) => {
  await page.route(/\/library\/tv:1\/episodes\?season=1$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const [unlinked, searching, linked] = body.episodes;
    Object.assign(unlinked, { monitored: true, hasFile: false, queue: 'available' });
    Object.assign(searching, { monitored: true, hasFile: false, queue: 'searching' });
    Object.assign(linked, { monitored: true, hasFile: true, queue: 'available' });
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${URL_BASE}/catalog/tv/1`);
  await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
  const table = page.getByRole('region', { name: 'Season 1', exact: true }).getByRole('table', { name: 'Episodes' });
  const status = (name: string) => table.getByRole('row').filter({ has: page.getByText(name, { exact: true }) }).getByRole('cell').last();
  await expect(status('Episode 1')).toHaveText(/link|associat|match|map/i);
  await expect(status('Episode 2')).toHaveText('Searching');
  await expect(status('Episode 3')).toHaveText('Available');
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
  await expect(dialog).toContainText('Nothing to search');
  await dialog.getByText('Close', { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Only Search and Delete are left.
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  for (const name of ['Pause', 'Resume', 'Refresh metadata', 'Set quality', 'Clear selection']) await expect(page.getByRole('button', { name })).toHaveCount(0);
});

test('a file that is not a backup is refused and nothing changes', async ({ page }) => {
  await page.goto(URL_BASE);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Backups' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import backup' }).click();
  const file = { name: 'not-a-backup.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip file') };
  await (await chooser).setFiles(file);

  const dialog = page.getByRole('dialog', { name: 'Restore this backup?' });
  await expect(dialog).toContainText('This replaces the app data with the data of the file.');
  await expect(dialog).not.toContainText(file.name);
  const upload = page.waitForRequest((request) => request.method() === 'POST' && request.url() === `${URL_BASE}/api/backups/restore`);
  await dialog.getByRole('button', { name: 'Restore' }).click();
  const request = await upload;
  expect(request.headers()['content-type']).toBe(file.mimeType);
  expect(request.postDataBuffer()).toEqual(file.buffer);
  const rejection = dialog.getByRole('alert');
  await expect(rejection).toBeVisible();
  await expect(rejection).toHaveText('The file is not a backup of this app.');
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
  await page.getByRole('main').getByRole('link', { name: /Movie Name Movies$/ }).getByText('Movie Name', { exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/movie\/2$/);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await titleAdd(page).click();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  expect((await stack.call('GET', '/library/movie:2')).body.title.presetOverride).toBeNull();
});

test('the catalog shows the type of a title on its poster', async ({ page }) => {
  await page.goto(URL_BASE);
  const movie = page.getByRole('main').getByRole('link', { name: /^Movie Name Movies(?: |$)/ });
  const show = page.getByRole('main').getByRole('link', { name: /^Show Name Series(?: |$)/ });
  await expect(movie).toBeVisible();
  await expect(show).toBeVisible();
  await expect(movie).toContainText('Movies');
  await expect(show).toContainText('Series');
  // The poster shows no availability badge.
  await expect(movie).not.toContainText('Available');
  await expect(show).not.toContainText('Available');
  // The row of posters starts at the left edge of the centered gallery.
  const gallery = (await movie.locator('../..').boundingBox())!;
  const main = (await page.getByRole('main').boundingBox())!;
  const boxes = [(await movie.boundingBox())!, (await show.boundingBox())!].sort((a, b) => a.x - b.x);
  expect(Math.abs(boxes[0]!.x - gallery.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(gallery.x + gallery.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
  const patched = await stack.call('PATCH', '/library/tv:1', { seriesType: 'anime' });
  if (patched.status >= 300) throw new Error(`PATCH /library/tv:1 answered ${patched.status}: ${JSON.stringify(patched.body)}`);
  try {
    await page.reload();
    const anime = page.getByRole('main').getByRole('link', { name: /^Show Name Anime(?: |$)/ });
    await expect(anime).toBeVisible();
  } finally {
    const restored = await stack.call('PATCH', '/library/tv:1', { seriesType: 'standard' });
    if (restored.status >= 300) throw new Error(`PATCH /library/tv:1 answered ${restored.status}: ${JSON.stringify(restored.body)}`);
  }
});

test('Search results can be selected, many at once, and a new search clears the selection', async ({ page }) => {
  await page.goto(`${URL_BASE}/discovery?q=Name`);
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
  await expect(page).toHaveURL(/\/discovery\?q=Movie$/);
  await expect(page.getByRole('checkbox', { name: 'Movie Name', exact: true })).toBeVisible();
});

test('an old movie ID search opens its result in Discovery', async ({ page }) => {
  await page.goto(`${URL_BASE}/search?q=2`);
  await expect(page).toHaveURL(/\/discovery\?q=2$/);
  await expect(page.getByRole('link', { name: /Movie Name/ })).toBeVisible();
});

test('a series ID shows its result in Discovery', async ({ page }) => {
  await page.goto(`${URL_BASE}/discovery?q=1`);
  await expect(page.getByRole('link', { name: /Show Name/ })).toBeVisible();
  await expect(page).toHaveURL(/\/discovery\?q=1$/);
});

test('a number that is no TMDB ID stays in Discovery', async ({ page }) => {
  await page.goto(`${URL_BASE}/search?q=9999`);
  await expect(page).toHaveURL(/\/discovery\?q=9999$/);
  await expect(page.getByText('No titles match.', { exact: true })).toBeVisible();
});

test('a bare TMDB ID typed in the search box opens Discovery until a title is selected', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog`);
  await page.getByRole('searchbox', { name: 'Search' }).fill('2');
  await expect(page).toHaveURL(/\/discovery\?q=2$/);
  await page.getByRole('link', { name: /Movie Name/ }).getByText('Movie Name', { exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/movie\/2$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Movie Name (2019)' })).toBeVisible();
});

test('the page of a title shows the TMDB score, the cast, and the recommendations', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog/movie/2`);
  await expect(page.getByRole('main').getByText('7.5', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'TMDB', exact: true })).toHaveAttribute('href', 'https://www.themoviedb.org/movie/2');
  await expect(page.getByRole('heading', { name: 'Cast' })).toBeVisible();
  await expect(page.getByText('Actor One')).toBeVisible();
  await expect(page.getByText('Role One')).toBeVisible();
  // A recommended title that is not in the catalog opens the same page, with a button that searches for it.
  await page.getByRole('link', { name: /Bench Movie Alpha/ }).getByText('Bench Movie Alpha', { exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/movie\/900001$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Bench Movie Alpha (2019)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await titleAdd(page).click();
  // The page stays at the same address, and it shows the actions of a title that is in the catalog now.
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
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
  await expect(page.getByRole('alert').getByText('Nothing to search')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Show details of / })).toHaveCount(0);
  const menu = page.getByRole('menu');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Upgrade', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const alert = page.getByRole('alertdialog', { name: 'Delete Show Name?' });
  await expect(alert).toBeVisible();
  const plans: string[] = [];
  page.on('request', (request) => request.url().includes('/library/plans') && plans.push(request.url()));
  const deleteFiles = alert.getByRole('checkbox', { name: 'Delete the files too' });
  await expect(deleteFiles).not.toBeChecked();
  await deleteFiles.click();
  await expect(deleteFiles).toBeChecked();
  await expect(alert.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  await expect(alert.getByRole('button')).toHaveText(['Cancel', 'Delete']);
  expect(plans).toEqual([]);
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toHaveCount(0);

  // The movie has a file, as the server sends it.
  await page.route(/\/library\/movie:2$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.title.availability = 'available';
    body.title.downloadedQualities = [
      { resolution: 2160, label: 'BluRay 2160p' },
      { resolution: 1080, label: 'WEB-DL 1080p' },
    ];
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/library\/movie:2\/upgrades$/, (route) => route.fulfill({ json: { qualities: [{ id: 'webdl-1080', label: 'WEB-DL 1080p' }, { id: 'bluray-2160', label: 'BluRay 2160p' }] } }));
  await page.goto(`${URL_BASE}/catalog/movie/2`);
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Show details of / })).toHaveText(['BluRay 2160p', 'WEB-DL 1080p']);
  await expect(page.getByRole('button', { name: 'Upgrade', exact: true })).toHaveCount(0);
  // Upgrade asks for a quality first, then for a plan of the title.
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  const upgrade = menu.getByRole('menuitem', { name: 'Upgrade', exact: true });
  await expect(upgrade).toBeEnabled();
  await upgrade.click();
  const dialog = page.getByRole('dialog', { name: 'Search for upgrades' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Quality' }).click();
  await page.getByRole('option', { name: 'WEB-DL 1080p' }).click();
  const preview = page.waitForRequest((request) => request.url().endsWith('/library/search/preview') && request.postData()?.includes('"upgrades"') === true && request.postData()?.includes('"quality":"webdl-1080"') === true);
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  await preview;
});

test('a title that has no better quality has Upgrade disabled', async ({ page }) => {
  for (const [mediaType, id] of [['movie', 2], ['tv', 1]] as const) {
    const path = `/library/${mediaType}:${id}`;
    await page.route(`**${path}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.title.availability = 'available';
      if (mediaType === 'tv') body.title.counts.available = 1;
      body.title.downloadedQualities = [
        { resolution: 2160, label: 'BluRay 2160p' },
        { resolution: 1080, label: 'WEB-DL 1080p' },
      ];
      await route.fulfill({ response, json: body });
    });
    await page.route(`**${path}/upgrades`, (route) => route.fulfill({ json: { qualities: [] } }));
    const upgrades = page.waitForResponse((response) => response.url().endsWith(`${path}/upgrades`) && response.ok());
    await page.goto(`${URL_BASE}/catalog/${mediaType}/${id}`);
    await upgrades;
    await expect(page.getByRole('button', { name: 'Upgrade', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    const upgrade = page.getByRole('menu').getByRole('menuitem', { name: 'Upgrade', exact: true });
    await expect(upgrade).toBeDisabled();
  }
});

test('Delete asks in an alert, and the page stays open as a title that is not in the catalog', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog/movie/900001`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const alert = page.getByRole('alertdialog', { name: 'Delete Bench Movie Alpha?' });
  await expect(alert.getByRole('checkbox', { name: 'Delete the files too' })).not.toBeChecked();
  await alert.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Bench Movie Alpha removed from the library')).toBeVisible();
  await expect(page).toHaveURL(/\/catalog\/movie\/900001$/);
  await expect(titleAdd(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
});

test('removing a series tells the person that it is out of the library', async ({ page }) => {
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 3, add: 'paused' });
  expect(added.status).toBe(201);
  await page.goto(`${URL_BASE}/catalog/tv/3`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Delete Two Seasons?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Two Seasons removed from the library')).toBeVisible();
  await expect(titleAdd(page)).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
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
  // The fixed background covers the window even at the end of the page.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const bounds = await page.evaluate(() => {
    const layer = [...document.querySelector('main')!.parentElement!.children].find((element) => {
      const style = getComputedStyle(element);
      return style.position === 'fixed' && style.backgroundImage !== 'none';
    });
    const rect = layer?.getBoundingClientRect();
    return rect && { top: rect.top, bottomBand: innerHeight - rect.bottom };
  });
  expect(bounds).toBeDefined();
  expect(Math.abs(bounds!.top)).toBeLessThan(1);
  expect(Math.abs(bounds!.bottomBand)).toBeLessThan(1);
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

  await expect(moveUp('1080p')).toHaveCount(0);
  await expect(moveDown('2160p')).toBeDisabled();
});

test('the file size limits are in the dialog of the profile', async ({ page }) => {
  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('tab', { name: 'Quality' }).click();
  // The sizes are no longer a section of their own.
  await expect(page.getByRole('region', { name: 'File size' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Actions for 1080p' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit quality' });
  const media = dialog.getByRole('combobox', { name: 'Media' });
  await expect(media).toContainText('Movies');

  await dialog.getByRole('button', { name: 'Show size limits for 1080p' }).click();
  const minimum = dialog.getByRole('spinbutton', { name: 'Minimum for WEB-DL 1080p' });
  await expect(minimum).toHaveValue('');
  await expect(minimum).toHaveAttribute('placeholder', '∞');
  await media.click();
  await page.getByRole('option', { name: 'Series' }).click();
  await expect(minimum).toHaveValue('12.5');

  try {
    await minimum.fill('15.1');
    await expect(minimum).toHaveValue('15.1');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await stack.call('GET', '/quality')).body.sizes.tv['webdl-1080'].min).toBe(15.1);
  } finally {
    // The size belongs to the quality of the series table, so the test puts the default back for the next tests.
    await stack.call('PUT', '/quality/sizes/tv/webdl-1080', { min: 12.5, preferred: null, max: null });
  }
});

test('an empty size limit shows infinity and saves as no limit', async ({ page }) => {
  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('tab', { name: 'Quality' }).click();
  await page.getByRole('button', { name: 'Actions for 1080p' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit quality' });
  const media = dialog.getByRole('combobox', { name: 'Media' });
  await media.click();
  await page.getByRole('option', { name: 'Series' }).click();
  await dialog.getByRole('button', { name: 'Show size limits for 1080p' }).click();

  const minimum = dialog.getByRole('spinbutton', { name: 'Minimum for WEB-DL 1080p' });
  try {
    await minimum.fill('');
    await expect(minimum).toHaveAttribute('placeholder', '∞');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect.poll(async () => (await stack.call('GET', '/quality')).body.sizes.tv['webdl-1080'].min).toBeNull();
    // The empty minimum persists when the dialog opens again.
    await page.getByRole('button', { name: 'Actions for 1080p' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await media.click();
    await page.getByRole('option', { name: 'Series' }).click();
    await dialog.getByRole('button', { name: 'Show size limits for 1080p' }).click();
    await expect(minimum).toHaveValue('');
    await expect(minimum).toHaveAttribute('placeholder', '∞');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  } finally {
    // The size belongs to the quality of the series table, so the test puts the default back for the next tests.
    await stack.call('PUT', '/quality/sizes/tv/webdl-1080', { min: 12.5, preferred: null, max: null });
  }
});

test('the table of the profile scrolls sideways under its first column', async ({ page }) => {
  // A narrow window makes the table wider than the page, so it scrolls sideways.
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('tab', { name: 'Quality' }).click();
  await page.getByRole('button', { name: 'Actions for 1080p' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();

  const dialog = page.getByRole('dialog', { name: 'Edit quality' });
  const table = dialog.getByRole('table', { name: 'Qualities' });
  const header = (name: string) => table.getByRole('columnheader', { name, exact: true });
  // The label of the first column is hidden, so its name starts with "Resolution".
  const resolutionHeader = table.getByRole('columnheader', { name: /^Resolution/ });
  await expect(resolutionHeader).toBeVisible();
  for (const name of ['Remux', 'BluRay', 'WEBRip', 'WEB-DL', 'Raw-HD', 'HDTV', 'SDTV', 'DVD']) {
    await expect(header(name)).toBeVisible();
  }
  await expect(table.getByRole('row').filter({ hasText: '576p' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Show size limits for 1080p' }).click();
  // The table is wider than the page, so it scrolls sideways. The first column stays at the left edge.
  const resolutionBefore = (await resolutionHeader.boundingBox())!.x;
  const sourceBefore = (await header('Remux').boundingBox())!.x;
  await table.evaluate((element) => { (element.parentElement as HTMLElement).scrollLeft = 400; });
  await page.waitForTimeout(200);
  const resolutionAfter = (await resolutionHeader.boundingBox())!.x;
  const sourceAfter = (await header('Remux').boundingBox())!.x;
  expect(Math.abs(resolutionAfter - resolutionBefore)).toBeLessThanOrEqual(1);
  expect(sourceBefore - sourceAfter).toBeGreaterThan(100);
  await expect(table.getByRole('row').filter({ hasText: '1080p' })).toBeVisible();
});

test('the General tab changes the language of the interface', async ({ page }) => {
  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: 'Español' }).click();
  await expect(page.getByRole('link', { name: 'Catálogo', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Catálogo', exact: true })).toBeVisible();
  expect((await stack.call('GET', '/settings')).body.settings.language).toBe('es');
  await page.getByRole('combobox', { name: 'Idioma', exact: true }).click();
  await page.getByRole('option', { name: 'English' }).click();
  await expect(page.getByRole('link', { name: 'Catalog', exact: true })).toBeVisible();
  expect((await stack.call('GET', '/settings')).body.settings.language).toBe('en');
});

test('the Add button shows on hover only until the title is in the catalog', async ({ page }) => {
  await page.goto(`${URL_BASE}/catalog/movie/2`);
  const result = page.getByRole('main').getByRole('link', { name: /Bench Movie Alpha/ });
  const button = result.getByRole('button', { name: 'Add', exact: true });
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
  await expect(button).toHaveCount(0);
  await page.reload();
  await result.hover();
  await expect(button).toHaveCount(0);
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

test('Attach download on the page of a series imports the files of the folder', async ({ page }) => {
  const folder = join(stack.folders.downloads, 'Show Name S01E02');
  mkdirSync(folder, { recursive: true });
  const source = join(folder, 'Show.Name.S01E02.1080p.WEB-DL.mkv');
  writeFileSync(source, 'episode two');

  await page.goto(`${URL_BASE}/catalog/tv/1`);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Attach download', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Attach download', exact: true });
  await dialog.getByLabel('Folder').fill(folder);
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByText('The names match this title')).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 1 file', exact: true }).click();
  await expect(dialog.getByText('The run ended.')).toBeVisible({ timeout: 30_000 });

  const library = join(stack.folders.tv, 'Show Name (2020)', 'Season 01', 'Show Name - S01E02 - Episode 2.mkv');
  expect(existsSync(library)).toBe(true);
  expect(statSync(library).ino).toBe(statSync(source).ino);
});
