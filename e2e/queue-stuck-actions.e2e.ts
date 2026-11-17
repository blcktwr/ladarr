import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page, Request } from '@playwright/test';
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

function matchRequests(page: Page) {
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /^\/api\/queue\/entries\/[^/]+\/match$/.test(new URL(request.url()).pathname)) requests.push(request);
  });
  return requests;
}

async function expectMappings(requests: Request[], groups: { id: string | string[]; source: string; file: string; ids: string[]; covers?: { season: number; number: number }[] }[]) {
  expect(requests).toHaveLength(groups.length * 2);
  for (const [index, { id, covers, ...body }] of groups.entries()) {
    const preview = requests[index * 2]!;
    const applied = requests[index * 2 + 1]!;
    expect([id].flat().map((anchor) => `/api/queue/entries/${anchor}/match`)).toContain(new URL(preview.url()).pathname);
    expect(new URL(applied.url()).pathname).toBe(new URL(preview.url()).pathname);
    expect(preview.postDataJSON()).toMatchObject({ ...body, preview: true });
    const response = await preview.response();
    expect(response?.status()).toBe(200);
    const version = (await response!.json()).version;
    expect(version).toEqual(expect.any(String));
    expect(applied.postDataJSON()).toMatchObject({ ...body, version });
    expect(applied.postDataJSON().preview).not.toBe(true);
    if (covers) {
      expect(preview.postDataJSON().covers).toHaveLength(covers.length);
      expect(preview.postDataJSON().covers).toEqual(expect.arrayContaining(covers));
      expect(applied.postDataJSON().covers).toEqual(preview.postDataJSON().covers);
    }
    expect((await applied.response())?.status()).toBe(200);
  }
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
  test(`retries ${scenario.at} once through the Try again menu action`, async ({ page }) => {
    const stopped = blocked('movie:2', null, null, scenario.at, scenario.code);
    const unrelated = blocked('tv:1', 1, 1, 'importing', 'file_unmapped');
    data.queuePaused = true;
    download(stopped, MOVIE_RELEASE, { 'Movie.mkv': 'video' });
    if (scenario.at !== 'importing') stack.qbit.torrents.clear();
    if (scenario.at === 'fetching' || scenario.at === 'sending') stopped.transferHash = null;
    if (scenario.at === 'sending') stopped.source = { torrent: makeTorrent(MOVIE_RELEASE).toString('base64') };
    await start([stopped, unrelated]);
    const before = await entry(unrelated.id);

    await open(page, 'entry:movie:2');
    const main = page.getByRole('main');
    for (const label of ['Retry import', 'Retry fetch', 'Retry send', 'Check download']) {
      await expect(main.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    }
    await expect(main.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await main.getByRole('button', { name: 'Actions for Movie Name (2019)' }).click();
    const retry = page.getByRole('menuitem', { name: 'Try again', exact: true });
    await expect(retry).toHaveCount(1);
    for (const label of ['Retry import', 'Retry fetch', 'Retry send', 'Check download']) {
      await expect(page.getByRole('menuitem', { name: label, exact: true })).toHaveCount(0);
    }
    const [applied] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/queue/actions' && response.request().postDataJSON().preview !== true),
      retry.click(),
    ]);
    expect(applied.status()).toBe(200);
    expect(applied.request().postDataJSON()).toMatchObject({ action: 'retry', ids: [stopped.id] });
    expect(await entry(stopped.id)).toMatchObject({
      status: scenario.at === 'downloading' ? 'stuck' : scenario.at,
      phase: scenario.at,
      release: { title: MOVIE_RELEASE },
    });
    const type = { importing: 'import.run', fetching: 'queue.grab', sending: 'queue.send', downloading: 'queue.retry' }[scenario.at];
    if (scenario.at === 'downloading') {
      await expect.poll(() => {
        const saved = JSON.parse(readFileSync(join(stack.folders.config, 'queue.json'), 'utf8')) as Pick<Data, 'jobs'>;
        return Object.values(saved.jobs).filter((job) => job.type === type);
      }).toEqual([expect.objectContaining({
        type, state: 'waiting',
        payload: { entryIds: [stopped.id], checkDownload: true, revisions: { [stopped.id]: stopped.revision } },
      })]);
    } else {
      const jobs = (await stack.call('GET', '/queue/jobs')).body.items;
      expect(jobs).toEqual(expect.arrayContaining([expect.objectContaining({ type, state: 'waiting' })]));
    }
    expect(await entry(unrelated.id)).toEqual(before);
    expect(stack.tracker.state.downloads).toEqual([]);
    expect(stack.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
  });
}

test('shows source-scoped actions in one row without episode or reason lists', async ({ page }) => {
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
  await expect(maps).toHaveCount(1);
  await expect(main.getByText(/^Show Name S01E/)).toHaveCount(0);
  const actions = maps.locator('..');
  await expect(actions.getByRole('button', { name: 'Map episodes', exact: true })).toHaveCount(1);
  await expect(actions.getByRole('button', { name: 'Attach download', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Search releases', exact: true })).toBeVisible();
  await expect(actions).toHaveCSS('justify-content', 'flex-start');
  await expect(main.getByText('The pack did not hold every episode of the season.', { exact: true })).toHaveCount(0);

  const requests = matchRequests(page);
  await maps.click();
  const panel = page.getByRole('dialog');
  await expect(panel).toHaveAccessibleName(/Show Name.*Season 1/);
  const table = panel.getByRole('table', { name: 'Map episodes', exact: true });
  await expect(table.getByRole('columnheader')).toHaveText(['Episode']);
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table).toContainText('Show Name S01E01');
  await expect(table).toContainText('Show Name S01E02');
  await expect(table).not.toContainText('Show Name S01E03');
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('combobox', { name: 'Library', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Preview changes', exact: true })).toHaveCount(0);
  await expect(panel.getByText('Changes preview', { exact: true })).toHaveCount(0);
  for (const label of ['Original name', 'Location', 'Current association', 'Episodes in this file']) {
    await expect(panel.getByText(label, { exact: true })).toHaveCount(0);
  }
  const apply = panel.getByRole('button', { name: 'Apply mapping', exact: true });
  await expect(apply).toHaveCount(1);
  await expect(apply).toBeDisabled();
  await expect(panel.locator(':scope > :last-child > button', { hasText: 'Apply mapping' })).toBeVisible();
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    const viewport = page.viewportSize()!;
    return box ? Math.abs(box.x + box.width / 2 - viewport.width / 2) : Infinity;
  }).toBeLessThan(2);
  for (const [index, file] of ['Source A.mkv', 'Source B.mkv'].entries()) {
    await table.getByRole('row').filter({ hasText: `Show Name S01E0${index + 1}` }).getByRole('combobox').click();
    await expect(page.getByRole('option', { name: new RegExp(file.replace('.', '\\.')) })).toBeVisible();
    await expect(page.getByRole('option', { name: index === 0 ? /Source B\.mkv/ : /Source A\.mkv/ })).toHaveCount(0);
    await page.getByRole('option', { name: new RegExp(file.replace('.', '\\.')) }).click();
  }
  await expect(apply).toBeEnabled();
  expect(requests).toEqual([]);
  expect((await stack.call('GET', '/queue/groups/tv:1')).body.items.map((item: { status: string }) => item.status)).toEqual(['stuck', 'stuck', 'stuck']);
  await panel.getByRole('button', { name: 'Apply mapping', exact: true }).click();
  await expect(panel).toBeHidden();
  await expectMappings(requests, [
    { id: first.id, source: 'download', file: 'Source A.mkv', covers: [{ season: 1, number: 1 }], ids: [first.id] },
    { id: second.id, source: 'download', file: 'Source B.mkv', covers: [{ season: 1, number: 2 }], ids: [second.id] },
  ]);
  await expect.poll(async () => (await entry(first.id)).status, { timeout: 60_000 }).toBe('available');
  await expect.poll(async () => (await entry(second.id)).status, { timeout: 60_000 }).toBe('available');
  expect(await entry(absent.id)).toMatchObject({ status: 'stuck', phase: 'importing', reason: { code: 'pack_partial' } });
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
  await expect(page.getByRole('main').getByRole('button', { name: 'Retry fetch', exact: true })).toHaveCount(0);
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

test('maps one blocked episode and preserves the library file coverage across seasons', async ({ page }) => {
  const stopped = blocked('tv:3', 1, 1, 'importing', 'file_unmapped');
  const available = blocked('tv:3', 1, 2, 'importing', 'file_unmapped');
  available.state = { kind: 'available' };
  const outside = blocked('tv:3', 2, 4, 'importing', 'file_unmapped');
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
    episodes: [{ season: 1, number: 2 }, { season: 2, number: 3 }],
    missing: false,
    addedAt: Date.now(),
  };
  title.episodes.find((episode) => episode.season === 1 && episode.number === 2)!.fileId = 'segments';
  title.episodes.find((episode) => episode.season === 2 && episode.number === 3)!.fileId = 'segments';
  await start([stopped, available, outside]);
  const outsideBefore = await entry(outside.id);
  const availableBefore = await entry(available.id);
  const before = (await stack.call('GET', '/library/tv:3/files')).body.files;
  const requests = matchRequests(page);

  await open(page, 'group:tv:3:1');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel).toHaveAccessibleName(/Two Seasons.*Season 1/);
  const table = panel.getByRole('table', { name: 'Map episodes', exact: true });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('Two Seasons S01E01');
  for (const label of ['Two Seasons S01E02', 'Two Seasons S02E03', 'Two Seasons S02E04']) {
    await expect(table.getByText(label, { exact: true })).toHaveCount(0);
  }
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await table.getByRole('row').filter({ hasText: 'Two Seasons S01E01' }).getByRole('combobox').click();
  await page.getByRole('option', { name: /Segments\.mkv/ }).click();
  await expect(panel.getByRole('button', { name: 'Preview changes', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeEnabled();
  expect(requests).toEqual([]);
  expect((await stack.call('GET', '/library/tv:3/files')).body.files).toEqual(before);
  expect((await entry(stopped.id)).status).toBe('stuck');
  await panel.getByRole('button', { name: 'Apply mapping', exact: true }).click();
  await expect(panel).toBeHidden();
  const covers = [{ season: 1, number: 1 }, { season: 1, number: 2 }, { season: 2, number: 3 }];
  await expectMappings(requests, [{ id: stopped.id, source: 'library', file: rel, covers, ids: [stopped.id] }]);

  await expect.poll(async () => (await entry(stopped.id)).status, { timeout: 60_000 }).toBe('available');
  const files = (await stack.call('GET', '/library/tv:3/files')).body.files;
  expect(files).toHaveLength(1);
  expect(files[0].episodes).toHaveLength(covers.length);
  expect(files[0].episodes).toEqual(expect.arrayContaining(covers));
  expect(await entry(available.id)).toEqual(availableBefore);
  expect(await entry(outside.id)).toEqual(outsideBefore);
  const episodes = (await Promise.all([1, 2].map(async (season) => {
    const result = await stack.call('GET', `/library/tv:3/episodes?season=${season}`);
    expect(result.status).toBe(200);
    expect(result.body.episodes).toEqual(expect.any(Array));
    return result.body.episodes;
  }))).flat();
  const saved = JSON.parse(readFileSync(join(stack.folders.config, 'db.json'), 'utf8')) as Data;
  for (const point of [{ season: 1, number: 2 }, { season: 2, number: 3 }]) {
    expect(episodes.find((episode: { season: number; number: number }) => episode.season === point.season && episode.number === point.number)).toMatchObject({ hasFile: true });
    expect(saved.titles['tv:3']!.episodes.find((episode) => episode.season === point.season && episode.number === point.number)!.fileId).toBe('segments');
  }
  expect(stack.tracker.state.searches.filter((url) => url.searchParams.get('t') !== 'search' || url.searchParams.has('q'))).toEqual([]);
  expect(stack.tracker.state.downloads).toEqual([]);
  expect(stack.qbit.torrents.size).toBe(0);
});

test('uses one movie file selector and validates only when Apply mapping is clicked', async ({ page }) => {
  const stopped = blocked('movie:2', null, null, 'importing', 'file_not_found');
  download(stopped, MOVIE_RELEASE, { 'Feature A.mkv': 'one', 'Feature B.mkv': 'two' });
  await start([stopped]);
  const requests = matchRequests(page);

  await open(page, 'entry:movie:2');
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: 'Map episodes', exact: true })).toHaveCount(0);
  await main.getByRole('button', { name: 'Select file', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('table', { name: 'Map episodes', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('combobox')).toHaveCount(1);
  const apply = panel.getByRole('button', { name: 'Apply mapping', exact: true });
  await expect(apply).toBeDisabled();
  await expect(panel.locator(':scope > :last-child > button', { hasText: 'Apply mapping' })).toBeVisible();
  await panel.getByRole('combobox', { name: 'File', exact: true }).click();
  await page.getByRole('option', { name: /Feature B\.mkv/ }).click();
  await expect(panel.getByRole('button', { name: 'Preview changes', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeEnabled();
  expect(requests).toEqual([]);
  expect((await entry(stopped.id)).status).toBe('stuck');
  expect((await stack.call('GET', '/library/movie:2/files')).body.files).toHaveLength(0);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/queue/entries/${stopped.id}/match`, async (route) => {
    if (route.request().postDataJSON().preview === true) await held;
    await route.continue();
  });
  await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith(`/${stopped.id}/match`) && request.postDataJSON().preview === true),
    apply.click(),
  ]);
  try {
    await expect(apply).toBeDisabled();
    await expect(panel).toBeVisible();
  } finally {
    release();
  }
  await expect(panel).toBeHidden();
  await expectMappings(requests, [{ id: stopped.id, source: 'download', file: 'Feature B.mkv', ids: [stopped.id] }]);
  await expect.poll(async () => (await entry(stopped.id)).status, { timeout: 60_000 }).toBe('available');
  const files = (await stack.call('GET', '/library/movie:2/files')).body.files;
  expect(files).toHaveLength(1);
  expect(readFileSync(join(stack.folders.movies, files[0].path), 'utf8')).toBe('two');
});

test('offers download files without a library source for one target that already has a torrent', async ({ page }) => {
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
  const requests = matchRequests(page);

  await open(page, 'group:tv:3:1');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  const table = panel.getByRole('table', { name: 'Map episodes', exact: true });
  await expect(table.getByRole('row')).toHaveCount(3);
  await panel.getByRole('combobox', { name: 'Two Seasons S01E01', exact: true }).click();
  await expect(page.getByRole('option', { name: /Library alternative\.mkv/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Download alternative\.mkv/ }).click();
  await expect(panel.getByRole('button', { name: 'Preview changes', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeEnabled();
  expect(requests).toEqual([]);
  expect((await entry(stopped.id)).status).toBe('stuck');
  expect((await stack.call('GET', '/library/tv:3/files')).body.files).toHaveLength(0);

  await panel.getByRole('button', { name: 'Apply mapping', exact: true }).click();
  await expect(panel).toBeHidden();
  await expectMappings(requests, [{ id: stopped.id, source: 'download', file: 'Download alternative.mkv', covers: [{ season: 1, number: 1 }], ids: [stopped.id] }]);
  await expect.poll(async () => (await entry(stopped.id)).status, { timeout: 60_000 }).toBe('available');
  expect(await entry(sibling.id)).toMatchObject({ status: 'stuck', phase: before.phase, revision: before.revision, manualMatch: null });
  const files = (await stack.call('GET', '/library/tv:3/files')).body.files;
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ episodes: [{ season: 1, number: 1 }] });
  expect(readFileSync(join(stack.folders.tv, files[0].path), 'utf8')).toBe('download-video');
  expect(readFileSync(path, 'utf8')).toBe('library-video');
  expect(stack.tracker.state.downloads).toEqual([]);
  expect(stack.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
});

for (const shared of [false, true]) {
  test(`saves two episode rows with ${shared ? 'one shared file' : 'two separate files'} and leaves the blank row blocked`, async ({ page }) => {
    const first = blocked('tv:1', 1, 1, 'importing', 'file_unmapped');
    const second = blocked('tv:1', 1, 2, 'importing', 'file_unmapped');
    const sibling = blocked('tv:1', 1, 3, 'importing', 'file_unmapped');
    download(first, 'Show.Name.S01.1080p.WEB-DL-GRP', { 'Part A.mkv': 'first-video', 'Part B.mkv': 'second-video' });
    for (const target of [second, sibling]) {
      Object.assign(target, { transferHash: first.transferHash, clientId: first.clientId, release: structuredClone(first.release) });
    }
    data.queuePaused = true;
    await start([first, second, sibling]);
    const siblingBefore = await entry(sibling.id);
    const requests = matchRequests(page);

    await open(page, 'group:tv:1:1');
    await page.getByRole('main').getByRole('button', { name: 'Map episodes', exact: true }).click();
    const panel = page.getByRole('dialog');
    const table = panel.getByRole('table', { name: 'Map episodes', exact: true });
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(table.getByRole('combobox')).toHaveCount(3);
    const apply = panel.getByRole('button', { name: 'Apply mapping', exact: true });
    await expect(apply).toBeDisabled();
    for (const [label, file] of [
      ['Show Name S01E01', /Part A\.mkv/],
      ['Show Name S01E02', shared ? /Part A\.mkv/ : /Part B\.mkv/],
    ] as const) {
      await table.getByRole('combobox', { name: label, exact: true }).click();
      await page.getByRole('option', { name: file }).click();
    }
    await expect(apply).toBeEnabled();
    expect(requests).toEqual([]);
    expect(await entry(sibling.id)).toEqual(siblingBefore);

    if (!shared) {
      const viewport = page.viewportSize()!;
      try {
        for (const width of [320, 375, 414, 768]) {
          await page.setViewportSize({ width, height: viewport.height });
          await expect.poll(() => panel.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const controls = [...element.querySelectorAll('table, [role="combobox"], button')];
            return Math.max(
              0, -bounds.left, bounds.right - document.documentElement.clientWidth,
              ...[element, ...element.children].map((child) => child.scrollWidth - child.clientWidth),
              ...controls.flatMap((control) => {
                const box = control.getBoundingClientRect();
                return [bounds.left - box.left, box.right - bounds.right, control.scrollWidth - control.clientWidth];
              }),
            );
          })).toBeLessThanOrEqual(1);
          await expect(apply).toBeInViewport({ ratio: 1 });
        }
      } finally {
        await page.setViewportSize(viewport);
      }
    }

    await apply.click();
    await expect(panel).toBeHidden();
    const firstGroup = { id: first.id, source: 'download', file: 'Part A.mkv', covers: [{ season: 1, number: 1 }], ids: [first.id] };
    await expectMappings(requests, shared ? [
      { ...firstGroup, covers: [{ season: 1, number: 1 }, { season: 1, number: 2 }], ids: [first.id, second.id] },
    ] : [
      firstGroup,
      { id: [first.id, second.id], source: 'download', file: 'Part B.mkv', covers: [{ season: 1, number: 2 }], ids: [second.id] },
    ]);
    if (!shared) {
      const firstPreview = (await (await requests[0]!.response())!.json()).version;
      const secondPreview = (await (await requests[2]!.response())!.json()).version;
      expect(secondPreview).not.toBe(firstPreview);
    }
    const jobs = (await stack.call('GET', '/queue/jobs')).body.items.filter((job: { type: string }) => job.type === 'import.run');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: 'waiting', payload: { hash: first.transferHash, manual: true, entryIds: [first.id, second.id] } });
    expect(await entry(sibling.id)).toEqual(siblingBefore);
    expect((await stack.call('POST', '/queue/pause', { paused: false })).status).toBe(200);
    await expect.poll(async () => (await entry(first.id)).status, { timeout: 60_000 }).toBe('available');
    await expect.poll(async () => (await entry(second.id)).status, { timeout: 60_000 }).toBe('available');
    expect(await entry(sibling.id)).toEqual(siblingBefore);
    const files = (await stack.call('GET', '/library/tv:1/files')).body.files;
    expect(files).toHaveLength(shared ? 1 : 2);
    const covers = files.flatMap((file: { episodes: { season: number; number: number }[] }) => file.episodes);
    expect(covers).toHaveLength(2);
    expect(covers).toEqual(expect.arrayContaining([{ season: 1, number: 1 }, { season: 1, number: 2 }]));
  });
}

test('keeps the season and existing associations unchanged when a file choice is cancelled', async ({ page }) => {
  const stopped = blocked('tv:3', 1, 1, 'importing', 'file_unmapped');
  const title = data.titles['tv:3']!;
  title.folder = 'Two Seasons (2021)';
  title.seasonOverrides['2'] = 'unmonitored';
  const rel = `${title.folder}/Season 01/Existing association.mkv`;
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
  await start([stopped]);
  const before = await entry(stopped.id);
  const filesBefore = (await stack.call('GET', '/library/tv:3/files')).body.files;
  const episodesBefore = await Promise.all([1, 2].map(async (season) => {
    const result = await stack.call('GET', `/library/tv:3/episodes?season=${season}`);
    expect(result.status).toBe(200);
    expect(result.body.episodes).toEqual(expect.any(Array));
    return result.body.episodes;
  }));
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /^\/api\/(queue|mapping|library)(\/|$)/.test(new URL(request.url()).pathname)) writes.push(request.url());
  });

  await open(page, 'group:tv:3:1');
  for (const close of ['Escape', 'Close']) {
    await page.getByRole('main').getByRole('button', { name: 'Map episodes', exact: true }).click();
    const panel = page.getByRole('dialog');
    const apply = panel.getByRole('button', { name: 'Apply mapping', exact: true });
    await expect(apply).toBeDisabled();
    const table = panel.getByRole('table', { name: 'Map episodes', exact: true });
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByText('Two Seasons S01E02', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('checkbox')).toHaveCount(0);
    await panel.getByRole('combobox', { name: 'Two Seasons S01E01', exact: true }).click();
    await page.getByRole('option', { name: /Existing association\.mkv/ }).click();
    await expect(apply).toBeEnabled();
    expect(writes).toEqual([]);
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await panel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel).toBeHidden();
  }
  expect(writes).toEqual([]);
  expect(await entry(stopped.id)).toEqual(before);
  expect((await stack.call('GET', '/library/tv:3/files')).body.files).toEqual(filesBefore);
  const episodesAfter = await Promise.all([1, 2].map(async (season) => {
    const result = await stack.call('GET', `/library/tv:3/episodes?season=${season}`);
    expect(result.status).toBe(200);
    return result.body.episodes;
  }));
  expect(episodesAfter).toEqual(episodesBefore);
  const saved = JSON.parse(readFileSync(join(stack.folders.config, 'db.json'), 'utf8')) as Data;
  expect(saved.titles['tv:3']!.episodes).toEqual(title.episodes);
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
  const requests = matchRequests(page);

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
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByRole('combobox')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeDisabled();
  await panel.getByRole('combobox', { name: 'File', exact: true }).click();
  await expect(page.getByRole('option', { name: /Download alternative\.mkv/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Movie Name \(2019\)\.mkv/ }).click();
  await expect(panel.getByRole('button', { name: 'Apply mapping', exact: true })).toBeEnabled();
  expect(requests).toEqual([]);
  expect((await entry(stopped.id)).status).toBe('stuck');
  expect(readFileSync(path, 'utf8')).toBe('library-video');
  await panel.getByRole('button', { name: 'Apply mapping', exact: true }).click();
  await expect(panel).toBeHidden();
  await expectMappings(requests, [{ id: stopped.id, source: 'library', file: rel, ids: [stopped.id] }]);
  await expect.poll(async () => (await entry(stopped.id)).status, { timeout: 60_000 }).toBe('available');
  const files = (await stack.call('GET', '/library/movie:2/files')).body.files;
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe(rel);
  expect(readFileSync(path, 'utf8')).toBe('library-video');
  expect(stack.tracker.state.downloads).toEqual([]);
  expect(stack.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
});

test('attaches the download to both descriptor targets when a stuck group saves', async ({ page }) => {
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
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(modal.getByRole('checkbox')).toHaveCount(0);
  await modal.getByRole('combobox', { name: 'Download', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(release.replaceAll('.', '\\.')) }).click();

  const path = `/api/queue/entries/${first.id}/attach`;
  const [preview, applied] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === path && response.request().postDataJSON().preview === true),
    page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === path && response.request().postDataJSON().preview !== true),
    modal.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  expect(preview.request().postDataJSON()).toMatchObject({ hash, ids: [second.id], preview: true });
  expect(preview.status()).toBe(200);
  expect((await preview.json()).affected.map((item: { id: string }) => item.id)).toEqual(action.ids);
  expect(applied.status()).toBe(200);
  expect(applied.request().postDataJSON()).toMatchObject({ hash, ids: [second.id], confirmOwner: true, confirmTitle: true, version: (await preview.json()).version });
  await expect(modal).toBeHidden();
  await expect.poll(async () => (await entry(first.id)).status, { timeout: 60_000 }).toBe('available');
  await expect.poll(async () => (await entry(second.id)).status, { timeout: 60_000 }).toBe('available');
});
