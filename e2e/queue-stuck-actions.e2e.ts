import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Data, QueueEntry } from '../packages/server/src/types.ts';
import { hashOf, makeTorrent } from '../packages/server/tests/helpers/test-pipeline.ts';
import { expect, test } from './fixtures.ts';
import { configure, MOVIE_RELEASE, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000 });

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
let baseline: Data;
let data: Data;

type Block = Extract<QueueEntry['state'], { kind: 'blocked' }>;

function blocked(titleKey: string, season: number | null, number: number | null, at: Block['at'], code: string): QueueEntry {
  const now = Date.now();
  return {
    id: season === null ? titleKey : `${titleKey}:${season}x${number}`,
    titleKey,
    season,
    number,
    state: { kind: 'blocked', at, problem: { code } },
    revision: ++data.queueRev,
    createdAt: now,
    stateSince: now,
    phaseSince: now,
    completedAt: null,
    clearedAt: null,
    priority: null,
    attempt: 1,
    attempts: [],
    history: [],
    search: null,
    release: null,
    transferHash: null,
    clientId: null,
    manualMatch: null,
    importResult: null,
    numbering: season === null ? null : { revision: 0, ranges: [] },
  };
}

function download(entry: QueueEntry, name: string, files: Record<string, string>) {
  const hash = hashOf(name);
  const clientId = data.downloadClients[0]!.id;
  entry.clientId = clientId;
  entry.transferHash = hash;
  entry.release = {
    guid: name,
    indexerId: Number(Object.keys(data.indexers)[0]),
    indexerName: 'Tracker',
    title: name,
    sizeBytes: 1_000_000,
    infoHash: hash,
    link: `http://127.0.0.1:${stack.tracker.port}/1/download?file=${encodeURIComponent(name)}`,
    magnet: null,
    kind: entry.season === null ? 'single' : 'pack',
    seeders: 1,
    manual: false,
  };
  stack.qbit.torrents.set(hash, {
    hash,
    name,
    size: 1_000_000,
    progress: 1,
    state: 'stoppedUP',
    category: 'ladarr',
    tags: '',
    save_path: stack.folders.downloads,
    content_path: join(stack.folders.downloads, name),
    dlspeed: 0,
    eta: 0,
    num_seeds: 1,
    num_leechs: 0,
    added_on: Math.floor(Date.now() / 1000),
  });
  stack.complete(name, files);
}

async function start(entries: QueueEntry[]) {
  data.queue = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
  for (const key of Object.keys(data.titles)) if (!entries.some((entry) => entry.titleKey === key)) delete data.titles[key];
  // A full snapshot takes precedence over queue.json.
  writeFileSync(join(stack.folders.config, 'db.json'), JSON.stringify(data));
  await stack.server.start();
}

const entry = async (id: string) => (await stack.call('GET', `/queue/entries/${id}`)).body.entry;

async function open(page: Page, row: string) {
  await page.goto(`${URL_BASE}/activity`);
  await page.locator(`[data-row="${row}"]`).click();
}

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  expect((await stack.call('POST', '/queue/pause', { paused: true })).status).toBe(200);
  for (const [mediaType, tmdbId] of [['tv', 1], ['tv', 3], ['movie', 2]] as const) {
    expect((await stack.call('POST', '/library', { mediaType, tmdbId, add: 'all' })).status).toBe(201);
  }
  for (const key of ['tv:1', 'tv:3']) {
    await expect.poll(async () => (await stack.call('GET', `/library/${key}`)).body.title.episodesLoadedAt, { timeout: 60_000 }).toBeTruthy();
  }
  await stack.server.stop();
  baseline = {
    ...JSON.parse(readFileSync(join(stack.folders.config, 'db.json'), 'utf8')),
    ...JSON.parse(readFileSync(join(stack.folders.config, 'queue.json'), 'utf8')),
    queue: {},
    jobs: {},
    imports: {},
    files: {},
    queuePaused: false,
  };
});

test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  data = structuredClone(baseline);
  for (const folder of [stack.folders.movies, stack.folders.tv, stack.folders.downloads]) {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder);
  }
  stack.qbit.torrents.clear();
  stack.qbit.calls.length = 0;
  stack.tracker.state.searches.length = 0;
  stack.tracker.state.downloads.length = 0;
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});
test.afterEach(() => stack.server.stop());

for (const scenario of [
  { at: 'importing', code: 'copy_incomplete', label: 'Retry import' },
  { at: 'fetching', code: 'grab_failed', label: 'Retry fetch' },
  { at: 'sending', code: 'grab_failed', label: 'Retry send' },
  { at: 'downloading', code: 'torrent_missing', label: 'Check download' },
] as const) {
  test(`names the stopped operation with ${scenario.label}`, async ({ page }) => {
    const stopped = blocked('movie:2', null, null, scenario.at, scenario.code);
    download(stopped, MOVIE_RELEASE, { 'Movie.mkv': 'video' });
    if (scenario.at !== 'importing') stack.qbit.torrents.clear();
    if (scenario.at === 'fetching' || scenario.at === 'sending') stopped.transferHash = null;
    if (scenario.at === 'sending') stopped.source = { torrent: makeTorrent(MOVIE_RELEASE).toString('base64') };
    await start([stopped]);

    await open(page, 'entry:movie:2');
    const main = page.getByRole('main');
    await expect(main.getByRole('button', { name: scenario.label, exact: true })).toBeVisible();
    for (const label of ['Retry import', 'Retry fetch', 'Retry send', 'Check download']) {
      if (label !== scenario.label) await expect(main.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    }
    await expect(main.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await main.getByRole('button', { name: 'Actions for Movie Name (2019)' }).click();
    await expect(page.getByRole('menuitem', { name: 'Try again', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(await entry(stopped.id)).toMatchObject({ status: 'stuck', phase: scenario.at, reason: { code: scenario.code } });
  });
}

test('shows each cause and source of a mixed stuck season before its episodes open', async ({ page }) => {
  const first = blocked('tv:1', 1, 1, 'importing', 'file_unmapped');
  const second = blocked('tv:1', 1, 2, 'importing', 'file_unmapped');
  const absent = blocked('tv:1', 1, 3, 'importing', 'pack_partial');
  const sources = ['Show.Name.S01.Source-A.1080p.WEB-DL-GRP', 'Show.Name.S01.Source-B.1080p.WEB-DL-GRP'];
  download(first, sources[0]!, { 'Source A.mkv': 'one' });
  download(second, sources[1]!, { 'Source B.mkv': 'two' });
  download(absent, 'Show.Name.S01.Partial.1080p.WEB-DL-GRP', { 'Show.Name.S01E01.mkv': 'one' });
  await start([first, second, absent]);

  await open(page, 'group:tv:1:1');
  const main = page.getByRole('main');
  await expect(main.getByRole('table', { name: 'Episodes of season 1' })).toBeHidden();
  await expect(main.getByRole('button', { name: 'Search releases', exact: true }).first()).toBeVisible();
  await expect(main.getByRole('button', { name: 'Attach download', exact: true })).toBeVisible();
  const maps = main.getByRole('button', { name: 'Map episodes', exact: true });
  await expect(maps).toHaveCount(2);
  await expect(main.getByText('The pack did not hold every episode of the season.', { exact: true })).toBeVisible();

  for (const [index, file] of ['Source A.mkv', 'Source B.mkv'].entries()) {
    await maps.nth(index).click();
    const panel = page.getByRole('dialog');
    await panel.getByRole('combobox', { name: 'File', exact: true }).click();
    await expect(page.getByRole('option', { name: new RegExp(file.replace('.', '\\.')) })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  expect((await stack.call('GET', '/queue/groups/tv:1')).body.items.map((item: { status: string }) => item.status)).toEqual(['stuck', 'stuck', 'stuck']);
});

test('keeps a target stuck when Search releases only reads results', async ({ page }) => {
  const stopped = blocked('movie:2', null, null, 'fetching', 'too_many_attempts');
  download(stopped, MOVIE_RELEASE, { 'Movie.mkv': 'video' });
  stopped.transferHash = null;
  stack.qbit.torrents.clear();
  stopped.state = { kind: 'blocked', at: 'fetching', problem: { code: 'too_many_attempts', detail: 'invalid_torrent' } };
  await start([stopped]);
  const before = await entry(stopped.id);
  const searches = stack.tracker.state.searches.length;
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/queue')) writes.push(request.url());
  });

  await open(page, 'entry:movie:2');
  await expect(page.getByRole('main').getByRole('button', { name: 'Retry fetch', exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Search releases', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText(MOVIE_RELEASE, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
  expect(stack.tracker.state.searches.length).toBeGreaterThan(searches);
  expect(stack.tracker.state.downloads).toEqual([]);
  expect(stack.qbit.torrents.size).toBe(0);
  expect(writes).toEqual([]);
  expect(await entry(stopped.id)).toMatchObject({ status: 'stuck', phase: 'fetching', revision: before.revision, reason: before.reason });
});

test('maps one library file to several episodes from the complete series catalog', async ({ page }) => {
  const stopped = blocked('tv:3', 1, 1, 'importing', 'file_unmapped');
  const title = data.titles['tv:3']!;
  title.folder = 'Two Seasons (2021)';
  title.seasonOverrides['2'] = 'unmonitored';
  const rel = `${title.folder}/Season 01/Segments.mkv`;
  const path = join(stack.folders.tv, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'three-segments');
  const info = statSync(path);
  data.files.segments = {
    id: 'segments',
    titleKey: title.key,
    path: rel,
    sizeBytes: info.size,
    mtimeMs: info.mtimeMs,
    episodes: [{ season: 1, number: 2 }],
    missing: false,
    addedAt: Date.now(),
  };
  title.episodes.find((episode) => episode.season === 1 && episode.number === 2)!.fileId = 'segments';
  await start([stopped]);
  expect((await stack.call('GET', '/queue/groups/tv:3')).body.items).toHaveLength(1);
  const before = (await stack.call('GET', '/library/tv:3/files')).body.files;

  await open(page, 'group:tv:3:1');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes', exact: true }).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('combobox', { name: 'File', exact: true }).click();
  await page.getByRole('option', { name: /Segments\.mkv/ }).click();
  for (const label of ['Two Seasons S01E01', 'Two Seasons S01E02', 'Two Seasons S02E03', 'Two Seasons S02E04']) {
    await expect(panel.getByRole('checkbox', { name: label, exact: true })).toBeEnabled();
  }
  for (const label of ['Two Seasons S01E01', 'Two Seasons S01E02', 'Two Seasons S02E03']) {
    await panel.getByRole('checkbox', { name: label, exact: true }).check();
  }
  await panel.getByRole('checkbox', { name: 'Two Seasons S02E04', exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeEnabled();
  expect((await stack.call('GET', '/library/tv:3/files')).body.files).toEqual(before);
  expect((await entry(stopped.id)).status).toBe('stuck');
  await panel.getByRole('button', { name: 'Apply mapping', exact: true }).click();

  await expect.poll(async () => (await entry(stopped.id)).status, { timeout: 60_000 }).toBe('available');
  const files = (await stack.call('GET', '/library/tv:3/files')).body.files;
  expect(files).toHaveLength(1);
  expect(files[0].episodes).toEqual([{ season: 1, number: 1 }, { season: 1, number: 2 }, { season: 2, number: 3 }]);
  expect(stack.tracker.state.searches.filter((url) => url.searchParams.get('t') !== 'search' || url.searchParams.has('q'))).toEqual([]);
  expect(stack.tracker.state.downloads).toEqual([]);
  expect(stack.qbit.torrents.size).toBe(0);
});

test('uses Select file for a movie and previews the choice without episode controls', async ({ page }) => {
  const stopped = blocked('movie:2', null, null, 'importing', 'file_not_found');
  download(stopped, MOVIE_RELEASE, { 'Feature A.mkv': 'one', 'Feature B.mkv': 'two' });
  await start([stopped]);

  await open(page, 'entry:movie:2');
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: 'Map episodes', exact: true })).toHaveCount(0);
  await main.getByRole('button', { name: 'Select file', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await panel.getByRole('combobox', { name: 'File', exact: true }).click();
  await page.getByRole('option', { name: /Feature B\.mkv/ }).click();
  await panel.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeEnabled();
  expect((await entry(stopped.id)).status).toBe('stuck');
  expect((await stack.call('GET', '/library/movie:2/files')).body.files).toHaveLength(0);
  await panel.getByRole('button', { name: 'Apply mapping', exact: true }).click();
  await expect.poll(async () => (await entry(stopped.id)).status, { timeout: 60_000 }).toBe('available');
  const files = (await stack.call('GET', '/library/movie:2/files')).body.files;
  expect(files).toHaveLength(1);
  expect(readFileSync(join(stack.folders.movies, files[0].path), 'utf8')).toBe('two');
});

test('selects a library alternative for one target that already has a torrent', async ({ page }) => {
  const stopped = blocked('tv:3', 1, 1, 'importing', 'file_unmapped');
  const sibling = blocked('tv:3', 1, 2, 'importing', 'file_unmapped');
  const title = data.titles['tv:3']!;
  title.folder = 'Two Seasons (2021)';
  title.seasonOverrides['2'] = 'unmonitored';
  const rel = `${title.folder}/Season 01/Library alternative.mkv`;
  const path = join(stack.folders.tv, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'library-video');
  download(stopped, 'Two.Seasons.S01.1080p.WEB-DL-GRP', { 'Download alternative.mkv': 'download-video' });
  Object.assign(sibling, { transferHash: stopped.transferHash, clientId: stopped.clientId, release: structuredClone(stopped.release) });
  await start([stopped, sibling]);
  const before = await entry(sibling.id);
  const match = `/api/queue/entries/${stopped.id}/match`;
  const filesPath = `/api/queue/entries/${stopped.id}/files`;

  await open(page, 'group:tv:3:1');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toContainText('Download');
  await panel.getByRole('combobox', { name: 'Source', exact: true }).click();
  const [library] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === filesPath && new URL(response.url()).searchParams.get('source') === 'library'),
    page.getByRole('option', { name: 'Library', exact: true }).click(),
  ]);
  expect(library.status()).toBe(200);
  expect((await library.json()).files.map((file: { rel: string }) => file.rel)).toEqual([rel]);
  await panel.getByRole('combobox', { name: 'File', exact: true }).click();
  await expect(page.getByRole('option', { name: /Download alternative\.mkv/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Library alternative\.mkv/ }).click();
  await panel.getByRole('checkbox', { name: 'Two Seasons S01E01', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Two Seasons S01E02', exact: true }).uncheck();
  await panel.getByRole('checkbox', { name: 'Continue Two Seasons S01E01', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Continue Two Seasons S01E02', exact: true }).uncheck();
  const [preview] = await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === match),
    panel.getByRole('button', { name: 'Preview changes', exact: true }).click(),
  ]);
  expect(preview.postDataJSON()).toMatchObject({ source: 'library', file: rel, covers: [{ season: 1, number: 1 }], ids: [stopped.id], preview: true });
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeEnabled();
  expect((await entry(stopped.id)).status).toBe('stuck');
  expect((await stack.call('GET', '/library/tv:3/files')).body.files).toHaveLength(0);

  const [applied] = await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === match && request.postDataJSON().preview !== true),
    panel.getByRole('button', { name: 'Apply mapping', exact: true }).click(),
  ]);
  expect(applied.postDataJSON()).toMatchObject({ source: 'library', file: rel, covers: [{ season: 1, number: 1 }], ids: [stopped.id], version: expect.any(String) });
  await expect.poll(async () => (await entry(stopped.id)).status, { timeout: 60_000 }).toBe('available');
  expect(await entry(sibling.id)).toMatchObject({ status: 'stuck', phase: before.phase, revision: before.revision, manualMatch: null });
  const files = (await stack.call('GET', '/library/tv:3/files')).body.files;
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ path: rel, episodes: [{ season: 1, number: 1 }] });
  expect(readFileSync(path, 'utf8')).toBe('library-video');
  expect(stack.tracker.state.downloads).toEqual([]);
  expect(stack.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
});

test('removes all file associations without adding the anchor episode or authorizing a continuation', async ({ page }) => {
  const stopped = blocked('tv:3', 1, 1, 'importing', 'file_unmapped');
  const title = data.titles['tv:3']!;
  title.folder = 'Two Seasons (2021)';
  title.seasonOverrides['2'] = 'unmonitored';
  const rel = `${title.folder}/Season 01/Incorrect association.mkv`;
  const path = join(stack.folders.tv, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'library-video');
  const info = statSync(path);
  data.files.incorrect = {
    id: 'incorrect',
    titleKey: title.key,
    path: rel,
    sizeBytes: info.size,
    mtimeMs: info.mtimeMs,
    episodes: [{ season: 1, number: 2 }],
    missing: false,
    addedAt: Date.now(),
  };
  title.episodes.find((episode) => episode.season === 1 && episode.number === 2)!.fileId = 'incorrect';
  download(stopped, 'Two.Seasons.S01.1080p.WEB-DL-GRP', { 'Download alternative.mkv': 'download-video' });
  await start([stopped]);
  const before = await entry(stopped.id);
  const match = `/api/queue/entries/${stopped.id}/match`;
  const isPreview = (request: { method(): string; url(): string; postDataJSON(): any }) =>
    request.method() === 'POST' && (new URL(request.url()).pathname === '/api/mapping/preview' || (new URL(request.url()).pathname === match && request.postDataJSON().preview === true));

  await open(page, 'group:tv:3:1');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes', exact: true }).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('combobox', { name: 'Source', exact: true }).click();
  await page.getByRole('option', { name: 'Library', exact: true }).click();
  await panel.getByRole('combobox', { name: 'File', exact: true }).click();
  await page.getByRole('option', { name: /Incorrect association\.mkv/ }).click();
  await expect(panel.getByRole('checkbox', { name: 'Two Seasons S01E01', exact: true })).not.toBeChecked();
  await expect(panel.getByRole('checkbox', { name: 'Two Seasons S01E02', exact: true })).toBeChecked();
  await panel.getByRole('checkbox', { name: 'Two Seasons S01E02', exact: true }).uncheck();
  await panel.getByRole('checkbox', { name: 'Continue Two Seasons S01E01', exact: true }).uncheck();
  const [preview] = await Promise.all([
    page.waitForRequest(isPreview),
    panel.getByRole('button', { name: 'Preview changes', exact: true }).click(),
  ]);
  if (new URL(preview.url()).pathname === match) {
    expect(preview.postDataJSON()).toMatchObject({ source: 'library', file: rel, covers: [], ids: [], preview: true });
  } else {
    expect(preview.postDataJSON()).toMatchObject({ titleKey: title.key, entries: [{ path: rel, episodes: [] }], ids: [] });
  }
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeEnabled();
  expect((await stack.call('GET', '/library/tv:3/files')).body.files[0].episodes).toEqual([{ season: 1, number: 2 }]);
  expect((await entry(stopped.id)).status).toBe('stuck');

  const [applied] = await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && (new URL(request.url()).pathname === '/api/mapping/apply' || (new URL(request.url()).pathname === match && request.postDataJSON().preview !== true))),
    panel.getByRole('button', { name: 'Apply mapping', exact: true }).click(),
  ]);
  expect(applied.postDataJSON()).toMatchObject({ ids: [], version: expect.any(String) });
  if (new URL(applied.url()).pathname === match) expect(applied.postDataJSON()).toMatchObject({ source: 'library', file: rel, covers: [] });
  else expect(applied.postDataJSON()).toMatchObject({ titleKey: title.key, entries: [{ path: rel, episodes: [] }] });
  await expect.poll(async () => (await stack.call('GET', '/library/tv:3/files')).body.files[0].episodes).toEqual([]);
  expect(await entry(stopped.id)).toMatchObject({ status: 'stuck', phase: before.phase, hasTorrent: true, manualMatch: null });
  expect(await entry('tv:3:1x2')).toMatchObject({ status: 'stuck', phase: 'importing' });
  expect(readFileSync(path, 'utf8')).toBe('library-video');
  expect(statSync(path).ino).toBe(info.ino);
  expect(stack.tracker.state.downloads).toEqual([]);
  expect(stack.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
});

test('restricts Use existing file to library files when the destination exists', async ({ page }) => {
  const stopped = blocked('movie:2', null, null, 'importing', 'destination_exists');
  const title = data.titles['movie:2']!;
  title.folder = 'Movie Name (2019)';
  const rel = `${title.folder}/Movie Name (2019).mkv`;
  const path = join(stack.folders.movies, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'library-video');
  download(stopped, MOVIE_RELEASE, { 'Download alternative.mkv': 'download-video' });
  await start([stopped]);
  const filesPath = `/api/queue/entries/${stopped.id}/files`;
  const match = `/api/queue/entries/${stopped.id}/match`;

  await open(page, 'entry:movie:2');
  const use = page.getByRole('main').getByRole('button', { name: 'Use existing file', exact: true });
  await expect(use).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: 'Replace file', exact: true })).toBeVisible();
  const [library] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === filesPath && new URL(response.url()).searchParams.get('source') === 'library'),
    use.click(),
  ]);
  expect(library.status()).toBe(200);
  expect((await library.json()).files.map((file: { rel: string }) => file.rel)).toEqual([rel]);
  const panel = page.getByRole('dialog');
  const source = panel.getByRole('combobox', { name: 'Source', exact: true });
  if (await source.count()) {
    await expect(source).toContainText('Library');
    if (await source.isEnabled()) {
      await source.click();
      await expect(page.getByRole('option', { name: 'Download', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  }
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await panel.getByRole('combobox', { name: 'File', exact: true }).click();
  await expect(page.getByRole('option', { name: /Download alternative\.mkv/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Movie Name \(2019\)\.mkv/ }).click();
  const [preview] = await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === match),
    panel.getByRole('button', { name: 'Preview changes', exact: true }).click(),
  ]);
  expect(preview.postDataJSON()).toMatchObject({ source: 'library', file: rel, ids: [stopped.id], preview: true });
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeEnabled();
  expect((await entry(stopped.id)).status).toBe('stuck');
  expect(readFileSync(path, 'utf8')).toBe('library-video');
  const [applied] = await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === match && request.postDataJSON().preview !== true),
    panel.getByRole('button', { name: 'Apply mapping', exact: true }).click(),
  ]);
  expect(applied.postDataJSON()).toMatchObject({ source: 'library', file: rel, ids: [stopped.id], version: expect.any(String) });
  await expect.poll(async () => (await entry(stopped.id)).status, { timeout: 60_000 }).toBe('available');
  const files = (await stack.call('GET', '/library/movie:2/files')).body.files;
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe(rel);
  expect(readFileSync(path, 'utf8')).toBe('library-video');
  expect(stack.tracker.state.downloads).toEqual([]);
  expect(stack.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
});

test('keeps both descriptor targets selected when a stuck group opens Attach download', async ({ page }) => {
  const first = blocked('tv:3', 1, 1, 'sending', 'torrent_exists');
  const second = blocked('tv:3', 1, 2, 'sending', 'torrent_exists');
  data.titles['tv:3']!.seasonOverrides['2'] = 'unmonitored';
  const release = 'Two.Seasons.S01.1080p.WEB-DL-GRP';
  download(first, release, { 'Two.Seasons.S01E01.mkv': 'one', 'Two.Seasons.S01E02.mkv': 'two' });
  const hash = first.transferHash!;
  first.transferHash = null;
  first.clientId = null;
  first.release!.external = true;
  second.release = structuredClone(first.release);
  await start([first, second]);
  const group = (await stack.call('GET', '/queue/groups/tv:3')).body;
  const action = group.group.actions.find((item: { action: string }) => item.action === 'attach');
  expect(action.ids).toEqual([first.id, second.id]);

  await open(page, 'group:tv:3:1');
  const attach = page.getByRole('main').getByRole('button', { name: 'Attach download', exact: true });
  await expect(attach).toHaveCount(1);
  await attach.click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('combobox', { name: 'Download', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(release.replaceAll('.', '\\.')) }).click();
  await expect(panel.getByRole('checkbox', { name: 'Two Seasons S01E02', exact: true })).toBeChecked();

  const path = `/api/queue/entries/${first.id}/attach`;
  const [preview] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === path && response.request().postDataJSON().preview === true),
    panel.getByRole('button', { name: 'Preview attachment', exact: true }).click(),
  ]);
  expect(preview.request().postDataJSON()).toMatchObject({ hash, ids: [second.id], preview: true });
  expect(preview.status()).toBe(200);
  expect((await preview.json()).affected.map((item: { id: string }) => item.id)).toEqual(action.ids);
  expect((await entry(first.id)).status).toBe('stuck');
  expect((await entry(second.id)).status).toBe('stuck');
});
