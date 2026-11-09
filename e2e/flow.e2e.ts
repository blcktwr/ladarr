import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { MOVIE_RELEASE, OWNER, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';
import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';

// One server for the whole journey: setup first, then a movie, then a series. The tests depend on each other.
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

// The poller reads the client every 10 s, and a grab does not wake it. The first report of a new download can take that long.
async function firstReport(page: Page, transfers: number) {
  await expect.poll(async () => (await (await page.request.get(`${URL_BASE}/api/queue/summary`)).json()).activeTransfers, { timeout: 70_000, intervals: [500] }).toBe(transfers);
}

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(() => stack.stop());
test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  writeFileSync(info.outputPath('server.log'), stack.logs());
  await info.attach('server-log', { path: info.outputPath('server.log') });
});

async function signIn(page: Page) {
  await page.goto(URL_BASE);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Catalog', exact: true })).toBeVisible();
}

const section = (page: Page, name: string) => page.getByRole('link', { name, exact: true }).click();
// The queue status at the end of the navbar is the link to Activity. Its text changes with the queue.
const openActivity = (page: Page) => page.locator('a[href$="/activity"]').click();

async function addFromSearch(page: Page, query: string, heading: string, seasons = false) {
  const box = page.getByRole('searchbox', { name: 'Search', exact: true });
  await box.fill(query);
  await box.press('Enter');
  await page.getByRole('main').getByRole('link', { name: query }).getByText(query, { exact: true }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // A series asks which seasons to download first. The test wants all of them.
  if (seasons) {
    const dialog = page.getByRole('dialog', { name: 'Add new series' });
    await dialog.getByRole('checkbox', { name: 'All seasons' }).click();
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  }
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Added to the queue')).toBeVisible();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  // The page of the title has its action buttons when the title is in the catalog.
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
}

test('setup: owner, folders, download client, and indexer', async ({ page }) => {
  await page.goto(URL_BASE);
  await expect(page.getByRole('heading', { name: "Let's start" })).toBeVisible();
  await page.getByLabel(/^Password\b/).fill(OWNER.password);
  await page.getByLabel('Repeat password').fill('another password');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('The passwords do not match.')).toBeVisible();
  await expect(page.getByRole('heading', { name: "Let's start" })).toBeVisible();
  await page.getByLabel('Repeat password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set password' }).click();

  await expect(page.getByRole('heading', { name: 'Where is the media?' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: "Let's start" })).toBeVisible();
  await page.getByLabel(/^Password\b/).fill(OWNER.password);
  await page.getByLabel('Repeat password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('heading', { name: 'Where is the media?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Enter a full path that starts with /.')).toHaveCount(2);
  await page.getByLabel('Movies folder').fill(stack.folders.movies);
  await page.getByLabel('Series folder').fill(stack.folders.tv);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Connect the clients' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Where is the media?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Connect the clients' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Connect the clients' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Catalog', exact: true })).toHaveCount(0);
  // The step needs one indexer and one client that is on, so Continue waits for both, and says why.
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveAttribute('title', 'Indexer and download client required');
  await page.getByRole('button', { name: 'Add indexer' }).click();
  const setupIndexer = page.getByRole('dialog', { name: 'Add an indexer' });
  await setupIndexer.getByLabel(/^Name/).fill('Setup');
  await setupIndexer.getByLabel('Address').fill(`http://127.0.0.1:${stack.tracker.port}/2/`);
  await setupIndexer.getByLabel('API key').fill('indexer-key');
  await expect(setupIndexer.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await setupIndexer.getByRole('button', { name: 'Test connection' }).click();
  await expect(setupIndexer.getByText('Connected')).toBeVisible();
  await expect(setupIndexer.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  await setupIndexer.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(setupIndexer).toBeHidden();
  await page.getByRole('button', { name: 'Add client' }).click();
  const setupClient = page.getByRole('dialog', { name: 'Add a download client' });
  await setupClient.getByLabel(/^Name/).fill('Setup');
  await setupClient.getByLabel('Host').fill('127.0.0.1');
  await setupClient.getByLabel('Port').fill(String(stack.qbit.port));
  await setupClient.getByLabel('User name').fill('admin');
  await setupClient.getByLabel('Password').fill('secret');
  await expect(setupClient.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await setupClient.getByRole('button', { name: 'Test connection' }).click();
  await expect(setupClient.getByText('Connected')).toBeVisible();
  await expect(setupClient.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  await setupClient.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(setupClient).toBeHidden();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue' })).not.toHaveAttribute('title');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('link', { name: 'Catalog', exact: true })).toBeVisible();
  await expect(page.getByText('Your catalog is empty. Search for a title to add it.')).toBeVisible();

  // The rest of the test starts from empty lists, so the two items of the setup go away.
  const cleanupKey = (await (await page.request.get(`${URL_BASE}/api/auth/api-key`)).json()).apiKey;
  const cleanupHeaders = { 'x-api-key': cleanupKey };
  for (const created of (await (await page.request.get(`${URL_BASE}/api/clients`)).json()).clients) await page.request.delete(`${URL_BASE}/api/clients/${created.id}`, { headers: cleanupHeaders });
  for (const created of (await (await page.request.get(`${URL_BASE}/api/indexers`)).json()).indexers) await page.request.delete(`${URL_BASE}/api/indexers/${created.id}`, { headers: cleanupHeaders });

  await section(page, 'Settings');
  await page.getByRole('tab', { name: 'Connections' }).click();
  const clients = page.getByRole('table', { name: 'Download clients' });
  await expect(page.getByRole('region', { name: 'Download clients' }).getByText('No download client is set.')).toBeVisible();
  await page.getByRole('button', { name: 'Add client' }).click();
  const client = page.getByRole('dialog', { name: 'Add a download client' });
  await client.getByLabel(/^Name/).fill('qBittorrent');
  await client.getByLabel('Host').fill('127.0.0.1');
  await client.getByLabel('Port').fill(String(stack.qbit.port));
  await client.getByLabel('User name').fill('admin');
  await client.getByLabel('Password').fill('secret');
  await expect(client.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await client.getByRole('button', { name: 'Test connection' }).click();
  await expect(client.getByText('Connected')).toBeVisible();
  await expect(client.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  // A change to a field makes the result stale, so Add waits for a new test.
  await client.getByLabel(/^Name/).fill('qBittorrent 2');
  await expect(client.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await client.getByLabel(/^Name/).fill('qBittorrent');
  await client.getByRole('button', { name: 'Test connection' }).click();
  await expect(client.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  // The test saves nothing.
  expect((await (await page.request.get(`${URL_BASE}/api/clients`)).json()).clients).toEqual([]);
  await client.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(client).toBeHidden();
  await expect(clients.getByRole('cell', { name: `127.0.0.1:${stack.qbit.port}`, exact: true })).toBeVisible();
  // The checkbox in front of the name turns the client on or off.
  const enabled = clients.getByRole('checkbox', { name: 'qBittorrent' });
  await expect(enabled).toBeChecked();
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  expect((await (await page.request.get(`${URL_BASE}/api/clients`)).json()).clients[0].enabled).toBe(false);
  await enabled.click();
  await expect(enabled).toBeChecked();
  expect((await (await page.request.get(`${URL_BASE}/api/clients`)).json()).clients[0].enabled).toBe(true);

  // The menu of the row: test, edit without the password, and remove.
  const notices = page.getByRole('region', { name: 'Notifications' });
  await clients.getByRole('button', { name: 'Actions for qBittorrent' }).click();
  await page.getByRole('menuitem', { name: 'Test' }).click();
  await expect(notices.getByText('Connected to qBittorrent v5.0.4').first()).toBeVisible();
  await clients.getByRole('button', { name: 'Actions for qBittorrent' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit a download client' });
  await edit.getByLabel(/^Name/).fill('Seedbox');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(clients.getByRole('cell', { name: 'Seedbox', exact: true })).toBeVisible();
  await clients.getByRole('button', { name: 'Actions for Seedbox' }).click();
  await page.getByRole('menuitem', { name: 'Test' }).click();
  await expect(notices.getByText('Connected to qBittorrent v5.0.4').first()).toBeVisible();
  await page.getByRole('button', { name: 'Add client' }).click();
  const spare = page.getByRole('dialog', { name: 'Add a download client' });
  await spare.getByLabel(/^Name/).fill('Spare');
  await spare.getByLabel('Host').fill('127.0.0.1');
  await spare.getByLabel('Port').fill(String(stack.qbit.port));
  await spare.getByLabel('User name').fill('admin');
  await spare.getByLabel('Password').fill('secret');
  // The client stays off, so the poller does not read it while the test removes it.
  await spare.getByRole('checkbox', { name: 'Enabled' }).click();
  await spare.getByRole('button', { name: 'Test connection' }).click();
  await expect(spare.getByText('Connected')).toBeVisible();
  await spare.getByRole('button', { name: 'Add', exact: true }).click();
  await clients.getByRole('button', { name: 'Actions for Spare' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('alertdialog', { name: 'Remove Spare?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(clients.getByRole('cell', { name: 'Spare', exact: true })).toHaveCount(0);
  await expect(clients.getByRole('cell', { name: 'Seedbox', exact: true })).toBeVisible();

  // An indexer that the user adds: test, change, and remove.
  const indexers = page.getByRole('table', { name: 'Indexers' });
  const indexersEmpty = page.getByRole('region', { name: 'Indexers' });
  await expect(indexersEmpty.getByText('No indexer is set.')).toBeVisible();
  await page.getByRole('button', { name: 'Add indexer' }).click();
  const indexer = page.getByRole('dialog', { name: 'Add an indexer' });
  await indexer.getByLabel(/^Name/).fill('Manual');
  await indexer.getByLabel('Address').fill(`http://127.0.0.1:${stack.tracker.port}/2/`);
  await indexer.getByLabel('API key').fill('indexer-key');
  await expect(indexer.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await indexer.getByRole('button', { name: 'Test connection' }).click();
  await expect(indexer.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  // A change to a field makes the result stale, so Add waits for a new test.
  await indexer.getByLabel(/^Name/).fill('Manual 2');
  await expect(indexer.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await indexer.getByLabel(/^Name/).fill('Manual');
  await indexer.getByRole('button', { name: 'Test connection' }).click();
  await expect(indexer.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  await expect(indexer.getByText('Connected')).toBeVisible();
  // The test saves nothing.
  expect((await (await page.request.get(`${URL_BASE}/api/indexers`)).json()).indexers).toEqual([]);
  await indexer.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(indexer).toBeHidden();
  await expect(indexers.getByRole('cell', { name: 'Manual', exact: true })).toBeVisible();
  await indexers.getByRole('button', { name: 'Actions for Manual' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const editIndexer = page.getByRole('dialog', { name: 'Edit an indexer' });
  // The form shows the saved key.
  await expect(editIndexer.getByLabel('API key')).toHaveValue('indexer-key');
  await editIndexer.getByLabel(/^Name/).fill('Renamed');
  await editIndexer.getByRole('checkbox', { name: 'Interactive search' }).click();
  await editIndexer.getByRole('button', { name: 'Save' }).click();
  await expect(editIndexer).toBeHidden();
  await expect(indexers.getByRole('cell', { name: 'Renamed', exact: true })).toBeVisible();
  expect((await (await page.request.get(`${URL_BASE}/api/indexers`)).json()).indexers[0]).toMatchObject({ name: 'Renamed', manual: true, enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: false });
  // The checkbox in the row turns the three uses of the indexer off and on.
  const flags = async () => (await (await page.request.get(`${URL_BASE}/api/indexers`)).json()).indexers[0];
  await indexers.getByRole('checkbox', { name: 'Renamed' }).click();
  await expect.poll(flags).toMatchObject({ enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false });
  await indexers.getByRole('checkbox', { name: 'Renamed' }).click();
  await expect.poll(flags).toMatchObject({ enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true });
  await indexers.getByRole('button', { name: 'Actions for Renamed' }).click();
  await page.getByRole('menuitem', { name: 'Test' }).click();
  await expect(notices.getByText('Connected to the indexer.').first()).toBeVisible();
  await indexers.getByRole('button', { name: 'Actions for Renamed' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('alertdialog', { name: 'Remove Renamed?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(indexers.getByRole('cell', { name: 'Renamed', exact: true })).toHaveCount(0);
  await expect(indexersEmpty.getByText('No indexer is set.')).toBeVisible();

  // The indexer manager pushes an indexer while Settings is open, and the list changes without a reload. The manager owns its fields: the menu has no Remove, and the form has the delay and the preferred languages.
  const { apiKey } = await (await page.request.get(`${URL_BASE}/api/auth/api-key`)).json();
  await stack.pushIndexer(apiKey);
  await expect(indexers.getByRole('cell', { name: 'Tracker', exact: true })).toBeVisible();
  await indexers.getByRole('button', { name: 'Actions for Tracker' }).click();
  await expect(page.getByRole('menuitem', { name: 'Remove' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const pushed = page.getByRole('dialog', { name: 'Edit an indexer' });
  await expect(pushed.getByLabel('Delay requests')).toBeVisible();
  await expect(pushed.getByLabel('Preferred languages')).toBeVisible();
  await expect(pushed.getByLabel('Address')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(pushed).toBeHidden();

  // The webhook: an empty view, then one address that the user adds, tests, and removes. ladarr has one webhook, so Add waits until the user removes it.
  const receiver = createServer((_req, res) => void res.end('ok'));
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  await expect(page.getByText('No webhook is set.')).toBeVisible();
  await page.getByRole('button', { name: 'Add webhook' }).click();
  const hook = page.getByRole('dialog', { name: 'Add a webhook' });
  await hook.getByLabel('Address').fill(`http://${host}/hook`);
  await hook.getByRole('button', { name: 'Test connection' }).click();
  // The alerts wait under the modal, so the test checks that this one is there, and not that it shows.
  await expect(page.getByRole('region', { name: 'Notifications', includeHidden: true }).getByText('The receiver accepted the test event.')).toHaveCount(1);
  // The test saves nothing.
  expect((await (await page.request.get(`${URL_BASE}/api/webhook`)).json()).webhook).toBeNull();
  await hook.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(hook).toBeHidden();
  const webhook = page.getByRole('table', { name: 'Webhook' });
  await expect(webhook.getByRole('cell', { name: host, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add webhook' })).toBeDisabled();
  await webhook.getByRole('button', { name: `Actions for ${host}` }).click();
  await page.getByRole('menuitem', { name: 'Test' }).click();
  await expect(notices.getByText('The receiver accepted the test event.').first()).toBeVisible();
  await webhook.getByRole('button', { name: `Actions for ${host}` }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('alertdialog', { name: `Remove ${host}?` }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('No webhook is set.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add webhook' })).toBeEnabled();
  receiver.close();

  await page.getByRole('tab', { name: 'General' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await signIn(page);
});

test('movie: add, search, download, restart, import', async ({ page }) => {
  await signIn(page);
  await addFromSearch(page, 'Movie Name', 'Movie Name (2019)');

  await openActivity(page);
  const entry = page.locator('[data-row="entry:movie:2"]');
  await expect(entry).toContainText('Downloading');
  // The inspector shows the release that downloads, with its quality and its size.
  await expect(page.getByText(MOVIE_RELEASE, { exact: true })).toBeVisible();
  await expect(page.getByText('BluRay 1080p', { exact: true })).toBeVisible();
  await expect(page.getByText('11.7 GiB', { exact: true })).toBeVisible();
  // The poster and the name open the page of the title.
  await entry.getByRole('link', { name: 'Movie Name (2019)' }).click();
  await expect(page.getByRole('heading', { name: 'Movie Name (2019)' })).toBeVisible();
  await openActivity(page);
  await expect(page.getByRole('banner')).toContainText(/Downloading\s*Movie Name \(2019\)/);
  const hash = hashOf(MOVIE_RELEASE);
  expect(stack.qbit.torrents.get(hash)).toMatchObject({ tags: '', save_path: stack.folders.downloads });
  expect(stack.tracker.state.downloads).toEqual([MOVIE_RELEASE]);

  // The client reports the download. The row keeps the stage until the transfer completes.
  stack.qbit.progress(hash, 0.5);
  await firstReport(page, 1);
  await expect(entry).toContainText('Downloading');

  // A restart in the middle of the download. The entry and the transfer stay.
  await stack.restart('SIGTERM');
  await expect(entry).toContainText('Downloading');
  expect(stack.tracker.state.downloads).toEqual([MOVIE_RELEASE]);
  expect(stack.qbit.torrents.size).toBe(1);

  stack.complete(MOVIE_RELEASE, { [`${MOVIE_RELEASE}.mkv`]: 'video-data', 'Sample/sample.mkv': 'x', 'info.nfo': 'n' });
  // The poll reads the client every 10 seconds, so the import can wait that long to start. The row leaves the list when the
  // target is available, and the library file is the evidence that the import finished.
  const library = join(stack.folders.movies, 'Movie Name (2019)', 'Movie Name (2019).mkv');
  await expect.poll(() => existsSync(library), { timeout: 75_000 }).toBe(true);
  await expect(entry).toHaveCount(0, { timeout: 75_000 });
  expect(readFileSync(library, 'utf8')).toBe('video-data');
  // A hard link: the seeding source is untouched.
  expect(statSync(library).ino).toBe(statSync(join(stack.folders.downloads, MOVIE_RELEASE, `${MOVIE_RELEASE}.mkv`)).ino);
  expect(existsSync(join(stack.folders.movies, 'Movie Name (2019)', 'info.nfo'))).toBe(false);
  expect(stack.qbit.torrents.has(hash)).toBe(true);

  await section(page, 'Catalog');
  await expect(page.getByRole('main').getByRole('link', { name: 'Movie Name 2019', exact: true })).toBeVisible();
  // The poster has no availability badge and no type bookmark.
  await expect(page.getByRole('main').getByRole('link', { name: 'Movie Name 2019', exact: true })).not.toContainText('Available');
  await expect(page.getByRole('main').getByRole('link', { name: 'Movie Name 2019', exact: true })).not.toContainText('Movies');
});

test('the + of a season opens the add with that season', async ({ page }) => {
  await signIn(page);
  await page.goto(`${URL_BASE}/catalog/tv/1`);
  await page.getByRole('button', { name: 'Add Season 1' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add new series' });
  await expect(dialog.getByRole('checkbox', { name: 'Season 1' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('series: add, season pack, crash, import', async ({ page }) => {
  await signIn(page);
  await addFromSearch(page, 'Show Name', 'Show Name (2020)', true);

  await openActivity(page);
  const groupRow = page.locator('[data-row="group:tv:1"]');
  const groupMenu = page.getByRole('button', { name: 'Actions for Show Name (2020)' });
  // The row of the series shows its status. The movie of the test before comes first, so the user selects the series.
  await expect(groupRow).toContainText('Downloading');
  await page.getByRole('button', { name: 'Inspect Show Name (2020)' }).click();
  await expect(groupMenu).toBeVisible();
  // The poster and the name of the master row open the page of the title.
  await groupRow.getByRole('link', { name: 'Show Name (2020)' }).click();
  await expect(page.getByRole('heading', { name: 'Show Name (2020)' })).toBeVisible();
  await openActivity(page);
  // One pack, one transfer, three targets.
  expect(stack.tracker.state.downloads.filter((name) => name === SERIES_PACK)).toHaveLength(1);
  const hash = hashOf(SERIES_PACK);
  expect(stack.qbit.torrents.has(hash)).toBe(true);

  stack.qbit.progress(hash, 0.4);
  await firstReport(page, 1);
  await page.reload();
  // The page selects the first row, so the user selects the series. Its seasons are in the inspector, and the series
  // shows the status of its episodes.
  await page.getByRole('button', { name: 'Inspect Show Name (2020)' }).click();
  await expect(page.locator('[data-row="season:tv:1|1"]')).toBeVisible();
  await expect(groupRow).toContainText('Downloading');
  // A click on the button of the season opens its episodes in the inspector.
  await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
  await expect(page.getByRole('table', { name: 'Episodes of season 1' })).toBeVisible();

  // The process dies without a clean stop. The pack is not grabbed a second time.
  await stack.restart('SIGKILL');
  await expect(groupRow).toContainText('Downloading');
  expect(stack.tracker.state.downloads.filter((name) => name === SERIES_PACK)).toHaveLength(1);
  expect(stack.qbit.torrents.size).toBe(2);

  stack.complete(SERIES_PACK, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'Show.Name.S01E03.mkv': 'three' });
  // The row leaves the list when every episode is in the library. The library files are the evidence of the import.
  const files = [1, 2, 3].map((number) => join(stack.folders.tv, 'Show Name (2020)', 'Season 01', `Show Name - S01E0${number} - Episode ${number}.mkv`));
  await expect.poll(() => files.every((file) => existsSync(file)), { timeout: 75_000 }).toBe(true);
  await expect(groupRow).toHaveCount(0, { timeout: 75_000 });
  for (const file of files) expect(existsSync(file), file).toBe(true);

  await section(page, 'Catalog');
  await page.getByRole('link', { name: 'Show Name 2020', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Show Name (2020)' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'TMDB 8.1' })).toHaveAttribute('href', 'https://www.themoviedb.org/tv/1');
  await expect(page.getByRole('link', { name: 'IMDb' })).toHaveAttribute('href', 'https://www.imdb.com/title/tt0000001/');
  await expect(page.getByText('3 of 3 episodes available')).toHaveCount(0);

  // A click on the container of a season opens it, without the button at its right.
  await page.getByRole('region', { name: 'Season 1' }).click();
  await expect(page.getByRole('button', { name: 'Hide episodes of Season 1' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Season 1' })).toContainText('Episode 1');
});
