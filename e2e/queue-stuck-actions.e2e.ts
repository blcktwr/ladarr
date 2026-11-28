import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Locator, Page, Request } from '@playwright/test';
import type { Data, QueueEntry, RejectedRelease } from '../packages/server/src/types.ts';
import { hashOf, makeTorrent } from '../packages/server/tests/helpers/test-pipeline.ts';
import { expect, test } from './fixtures.ts';
import { configure, MIB, MOVIE_RELEASE, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000 });

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
let baseline: Data;
let data: Data;
let trackerItems: Stack['tracker']['state']['items'];

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
  const hash = completeTorrent(name, files);
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
}

function completeTorrent(name: string, files: Record<string, string>, category = 'ladarr') {
  const hash = hashOf(name);
  stack.qbit.torrents.set(hash, {
    hash,
    name,
    size: 1_000_000,
    progress: 1,
    state: 'stoppedUP',
    category,
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
  return hash;
}

function reject(entry: QueueEntry, title: string, files: string[]) {
  const indexerId = Number(Object.keys(data.indexers)[0]);
  const release: RejectedRelease = {
    title, guid: title, indexerId, link: `http://127.0.0.1:${stack.tracker.port}/1/download?file=${encodeURIComponent(title)}`,
    magnet: null, infoHash: hashOf(title, files), sizeBytes: 3 * 60 * 45 * MIB, seeders: 10, resolution: 1080,
    source: 'webdl', kind: 'pack', manifestProblem: 'file_unmapped',
    reasons: ['The releases available do not contain all the episodes.'], sizeRejection: null,
  };
  const search = entry.search ??= {
    at: Date.now(), candidates: 0, accepted: 0, result: 'all_rejected', topRejections: ['file_unmapped'],
    indexers: [], nextAt: null, rejected: [],
  };
  search.rejected.push(release);
  search.candidates++;
  stack.tracker.state.items.push({ title, size: release.sizeBytes, files });
  return release;
}

async function start(entries: QueueEntry[]) {
  data.queue = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
  for (const key of Object.keys(data.titles)) if (!entries.some((entry) => entry.titleKey === key)) delete data.titles[key];
  // These fixtures describe legacy targets. Let the loader rebuild their turns.
  const { queueItems, queueItemSeq, ...legacy } = data;
  writeFileSync(join(stack.folders.config, 'db.json'), JSON.stringify({ ...legacy, schemaVersion: 9 }));
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

const seasonPicker = (panel: Locator) => panel.getByRole('combobox').filter({ hasText: /^Season \d+$/ });
const seasonTable = (panel: Locator, number: number) => panel.getByRole('table', { name: `Episodes of season ${number}`, exact: true });
const seasonButton = (panel: Locator, number: number) => panel.getByRole('button', { name: `Season ${number}`, exact: true });
const labels = (table: Locator) => table.getByRole('cell', { name: /^S\d+E\d+$/ });
const selection = (panel: Locator) => panel.locator('tr[aria-selected="true"] > td:first-child');
const newSeason = (panel: Locator) => panel.getByRole('button', { name: 'New season', exact: true });
const episodeCell = (panel: Locator, label: string) => panel.getByRole('cell', { name: label, exact: true });
const episodeRow = (panel: Locator, label: string) => panel.getByRole('table', { name: /^Episodes of season / }).getByRole('row')
  .filter({ has: panel.page().getByRole('cell', { name: label, exact: true }) });

// A click selects the first episode, and each next click adds its row.
async function selectEpisodes(panel: Locator, ...episodes: string[]) {
  for (const [index, label] of episodes.entries()) {
    await episodeCell(panel, label).click({ modifiers: index ? ['ControlOrMeta'] : [] });
  }
}

async function openSeasonModal(panel: Locator) {
  await newSeason(panel).click();
  const modal = panel.page().getByRole('dialog', { name: 'New season', exact: true });
  return { modal, season: modal.getByRole('combobox', { name: 'Season', exact: true }), create: modal.getByRole('button', { name: 'Create', exact: true }) };
}

// Types a value that the list can lack. Escape closes the list.
async function typeSeason(season: Locator, value: string) {
  await season.fill(value);
  await season.press('Escape');
  await expect(season).toHaveValue(value);
}

// Moves the selected rows. The modal starts with `next`, and the user can type another target.
async function createSeason(panel: Locator, next: string, target = next) {
  const { modal, season, create } = await openSeasonModal(panel);
  await expect(season).toHaveValue(next);
  if (target !== next) await typeSeason(season, target);
  await create.click();
  await expect(modal).toBeHidden();
}

async function applyMapping(page: Page, panel: Locator, title = 'Apply this episode mapping?') {
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  const question = page.getByRole('dialog', { name: title, exact: true });
  await question.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(question).toBeHidden();
}

async function expectFooter(panel: Locator) {
  const apply = panel.getByRole('button', { name: 'Apply', exact: true });
  await expect(seasonPicker(panel)).toHaveCount(0);
  await expect(apply).toBeInViewport({ ratio: 1 });
  const [button, body] = await Promise.all([apply.boundingBox(), panel.locator(':scope > :has(table)').boundingBox()]);
  expect(button!.y).toBeGreaterThanOrEqual(body!.y + body!.height - 1);
}

async function expectMappings(requests: Request[], groups: { id: string | string[]; source: string; file: string; ids: string[]; hash?: string; covers?: { season: number; number: number }[] }[]) {
  expect(requests).toHaveLength(groups.length * 2);
  for (const [index, { id, covers, ids, ...body }] of groups.entries()) {
    const preview = requests[index * 2]!;
    const applied = requests[index * 2 + 1]!;
    expect([id].flat().map((anchor) => `/api/queue/entries/${anchor}/match`)).toContain(new URL(preview.url()).pathname);
    expect(new URL(applied.url()).pathname).toBe(new URL(preview.url()).pathname);
    expect(preview.postDataJSON()).toMatchObject({ ...body, preview: true });
    expect(preview.postDataJSON().ids.toSorted()).toEqual(ids.toSorted());
    const response = await preview.response();
    expect(response?.status()).toBe(200);
    const version = (await response!.json()).version;
    expect(version).toEqual(expect.any(String));
    expect(applied.postDataJSON()).toMatchObject({ ...body, version });
    expect(applied.postDataJSON().ids.toSorted()).toEqual(ids.toSorted());
    expect(applied.postDataJSON().preview).not.toBe(true);
    if (body.hash === undefined) {
      expect(preview.postDataJSON()).not.toHaveProperty('hash');
      expect(applied.postDataJSON()).not.toHaveProperty('hash');
    }
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
  trackerItems = [...stack.tracker.state.items];
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
  stack.tracker.state.items = [...trackerItems];
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
    if (scenario.at === 'sending') {
      const files = ['Movie.mkv'];
      const hash = hashOf(MOVIE_RELEASE, files);
      stopped.release!.infoHash = hash;
      stopped.clientId = null;
      stopped.source = { torrent: true };
      data.torrents[hash] = makeTorrent(MOVIE_RELEASE, files).toString('base64');
    }
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
      status: 'queued',
      phase: 'queued',
      hasTorrent: false,
    });
    const jobs = (await stack.call('GET', '/queue/jobs')).body.items;
    expect(jobs).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'queue.search', state: 'waiting' })]));
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
  await expect(main.getByRole('button', { name: 'Attach download', exact: true })).toHaveCount(0);
  const maps = main.getByRole('button', { name: 'Map episodes manually', exact: true });
  await expect(maps).toHaveCount(1);
  await expect(main.getByText(/^Show Name S01E/)).toHaveCount(0);
  const actions = maps.locator('..');
  await expect(actions.getByRole('button', { name: 'Map episodes manually', exact: true })).toHaveCount(1);
  await expect(actions).toHaveCSS('justify-content', 'flex-start');
  await expect(main.getByText('The pack did not hold every episode of the season.', { exact: true })).toHaveCount(0);

  const requests = matchRequests(page);
  await maps.click();
  const panel = page.getByRole('dialog');
  await expect(panel).toHaveAccessibleName('Show Name (2020)');
  const table = seasonTable(panel, 1);
  await expect(table.getByRole('columnheader')).toHaveText(['Episodes', 'Torrent', 'Matches']);
  await expect(table.getByRole('row')).toHaveCount(4);
  for (const label of ['S01E01', 'S01E02', 'S01E03']) await expect(table.getByText(label, { exact: true })).toHaveCount(1);
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('combobox', { name: 'Library', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Preview changes', exact: true })).toHaveCount(0);
  await expect(panel.getByText('Changes preview', { exact: true })).toHaveCount(0);
  for (const label of ['Original name', 'Location', 'Current association', 'Episodes in this file']) {
    await expect(panel.getByText(label, { exact: true })).toHaveCount(0);
  }
  const apply = panel.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toHaveCount(1);
  await expect(apply).toBeEnabled();
  await expectFooter(panel);
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    const viewport = page.viewportSize()!;
    return box ? Math.abs(box.x + box.width / 2 - viewport.width / 2) : Infinity;
  }).toBeLessThan(2);
  const rowOf = (episode: string) => table.getByRole('row').filter({ hasText: episode });
  await expect(rowOf('S01E03').getByRole('cell').last().getByRole('combobox')).toBeEnabled();
  for (const [index, file] of ['Source A.mkv', 'Source B.mkv'].entries()) {
    const cells = rowOf(`S01E0${index + 1}`).getByRole('cell');
    await expect(cells.getByRole('combobox', { name: 'Torrent' })).toHaveValue(sources[index]!);
    await cells.last().getByRole('combobox').click();
    await expect(page.getByRole('option', { name: new RegExp(file.replace('.', '\\.')) })).toBeVisible();
    await expect(page.getByRole('option', { name: index === 0 ? /Source B\.mkv/ : /Source A\.mkv/ })).toHaveCount(0);
    await page.getByRole('option', { name: new RegExp(file.replace('.', '\\.')) }).click();
  }
  await expect(apply).toBeEnabled();
  expect(requests).toEqual([]);
  expect((await stack.call('GET', '/queue/groups/tv:1')).body.items.map((item: { status: string }) => item.status)).toEqual(['stuck', 'stuck', 'stuck']);
  await apply.click();
  const question = page.getByRole('dialog', { name: 'Apply this episode mapping?' });
  expect(requests).toEqual([]);
  await question.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question).toBeHidden();
  await expect(rowOf('S01E01').getByRole('combobox', { name: 'Matches' })).toHaveValue(/Source A\.mkv/);
  await applyMapping(page, panel);
  await expect(panel).toBeHidden();
  await expectMappings(requests, [
    { id: first.id, source: 'download', file: 'Source A.mkv', covers: [{ season: 1, number: 1 }], ids: [first.id] },
    { id: second.id, source: 'download', file: 'Source B.mkv', covers: [{ season: 1, number: 2 }], ids: [second.id] },
  ]);
  await expect.poll(async () => (await entry(first.id)).status, { timeout: 60_000 }).toBe('available');
  await expect.poll(async () => (await entry(second.id)).status, { timeout: 60_000 }).toBe('available');
  expect(await entry(absent.id)).toMatchObject({ status: 'stuck', phase: 'importing', reason: { code: 'pack_partial' } });
  expect((await stack.call('GET', '/queue/groups/tv:1?season=1')).body.group.status).toBe('stuck');
});

test('maps selected episodes from a completed torrent with different season numbering', async ({ page }) => {
  const title = data.titles['tv:1']!;
  title.folder = 'Show Name (2020)';
  title.meta.seasons[0]!.episodeCount = 10;
  title.episodes = Array.from({ length: 10 }, (_, index) => ({
    ...title.episodes[0]!, tmdbId: 101 + index, number: index + 1, name: `Episode ${index + 1}`, fileId: null,
  }));
  const episodeLabel = (number: number) => `S01E${String(number).padStart(2, '0')}`;
  const firstPart = title.episodes.slice(0, 5);
  const available = firstPart.map(({ number }) => blocked(title.key, 1, number, 'importing', 'pack_partial'));
  download(available[0]!, 'Show.Name.S01.1080p.WEB-DL-GRP', Object.fromEntries(
    firstPart.map(({ number }) => [`Show.Name.${episodeLabel(number)}.mkv`, `first-part-${number}`]),
  ));
  const folder = `${title.folder}/Season 01`;
  mkdirSync(join(stack.folders.tv, folder), { recursive: true });
  for (const [index, episode] of firstPart.entries()) {
    Object.assign(available[index]!, {
      state: { kind: 'available' }, transferHash: available[0]!.transferHash, clientId: available[0]!.clientId,
      release: structuredClone(available[0]!.release),
    });
    const id = `imported-${episode.number}`;
    const name = `Show.Name.${episodeLabel(episode.number)}.mkv`;
    const path = `${folder}/${name}`;
    const abs = join(stack.folders.tv, path);
    writeFileSync(abs, `first-part-${episode.number}`);
    const { size, mtimeMs } = statSync(abs);
    data.files[id] = {
      id, titleKey: title.key, path, sizeBytes: size, mtimeMs, episodes: [{ season: 1, number: episode.number }],
      missing: false, addedAt: Date.now(),
      download: { hash: available[0]!.transferHash!, clientId: available[0]!.clientId!, external: false },
      association: { source: 'automatic', originalName: name, numberingRevision: 0, identity: { sizeBytes: size, mtimeMs } },
    };
    episode.fileId = id;
  }
  const secondFiles = Object.fromEntries(firstPart.map(({ number }) => [
    `Show.Name.S02E0${number}.${'Extra'.repeat(24)}.mkv`, `second-part-${number}`,
  ]));
  const longName = `Show.Name.S02.Second.Part.${'LongReleaseName'.repeat(10)}.1080p.WEB-DL-GRP`;
  const hash = completeTorrent(longName, secondFiles, '');
  const missing = title.episodes.slice(5).map(({ number }) => blocked(title.key, 1, number, 'importing', 'pack_partial'));
  const unselected = missing.at(-1)!;
  available[0]!.state = { kind: 'queued' };
  // A season without names starts a metadata refresh, and the refresh drops the episodes that TMDB does not have.
  title.meta.seasons.push({ seasonNumber: 0, episodeCount: 1, airDate: null, names: { en: null, es: null } });
  title.episodes.push(
    { ...title.episodes[0]!, tmdbId: 100, season: 0, fileId: null },
    { ...title.episodes[0]!, tmdbId: 111, number: 11, removedFromTmdb: true },
  );
  data.queuePaused = true;
  await start([...available, ...missing]);
  const before = await Promise.all(available.map((item) => entry(item.id)));
  expect(before[0].status).toBe('queued');
  const unselectedBefore = await entry(unselected.id);
  const filesPath = `/library/${title.key}/files`;
  const filesBefore = (await stack.call('GET', filesPath)).body.files as Data['files'][string][];
  expect(filesBefore).toHaveLength(5);
  const requests = matchRequests(page);

  await open(page, `group:${title.key}:1`);
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Show Name (2020)', exact: true });
  const table = seasonTable(panel, 1);
  await expect(table.getByRole('columnheader')).toHaveText(['Episodes', 'Torrent', 'Matches']);
  await expect(table.getByRole('row')).toHaveCount(11);
  await expect(table.getByText('S00E01', { exact: true })).toHaveCount(0);
  await expect(table.getByText('S01E11', { exact: true })).toHaveCount(0);
  const cellsOf = (label: string) => episodeRow(panel, label).getByRole('cell');
  for (const { number } of firstPart) {
    const cells = cellsOf(episodeLabel(number));
    await expect(cells.getByRole('combobox', { name: 'Torrent', exact: true })).toHaveValue('Show.Name.S01.1080p.WEB-DL-GRP');
    await expect(cells.last().getByRole('combobox', { name: 'Matches' })).toHaveValue(new RegExp(`Show.Name.${episodeLabel(number)}.mkv`));
  }
  const files = Object.keys(secondFiles);
  await expect(table).toHaveCSS('table-layout', 'fixed');
  // The later episodes move first.
  await selectEpisodes(panel, episodeLabel(8), episodeLabel(9));
  const { modal, season, create } = await openSeasonModal(panel);
  await expect(season).toHaveValue('2');
  await typeSeason(season, '12');
  // The open modal hides the dialog under it from the accessibility tree.
  await expect(page.getByRole('button', { name: 'Season 12', exact: true, includeHidden: true })).toHaveCount(0);
  await season.fill('2');
  const option = page.getByRole('option', { name: '2', exact: true });
  const label = option.getByText('2', { exact: true });
  await expect(label).toBeVisible();
  expect(await label.evaluate((node) => node.clientWidth >= node.scrollWidth)).toBe(true);
  await option.click();
  await create.click();
  await expect(modal).toBeHidden();
  const second = seasonTable(panel, 2);
  await expect(labels(second)).toHaveText(['S02E01', 'S02E02']);
  // The earlier episodes move last, into the same season. The numbers follow the order of TMDB.
  await selectEpisodes(panel, episodeLabel(6), episodeLabel(7));
  await createSeason(panel, '3', '2');
  await expect(labels(second)).toHaveText(['S02E01', 'S02E02', 'S02E03', 'S02E04']);
  await expect(labels(table)).toHaveText([1, 2, 3, 4, 5, 10].map(episodeLabel));
  for (const [index, target] of missing.entries()) {
    const moved = target.id !== unselected.id;
    const cells = cellsOf(moved ? `S02E0${index + 1}` : episodeLabel(target.number!));
    const headers = (moved ? second : table).getByRole('columnheader');
    const widths = () => headers.evaluateAll((all) => all.map((header) => header.clientWidth));
    const initialWidths = await widths();
    const input = cells.getByRole('combobox', { name: 'Torrent', exact: true });
    await input.fill('Second.Part');
    const torrent = page.getByRole('option', { name: /Show\.Name\.S02\.Second\.Part\./ });
    await expect(torrent).toBeVisible();
    await expect(page.getByRole('option', { name: /Show\.Name\.S01\./ })).toHaveCount(0);
    await torrent.click();
    await expect(input).toHaveValue(longName);
    await expect(cells.nth(1).getByRole('button', { name: /delete/i })).toHaveCount(0);
    const matches = cells.last().getByRole('combobox');
    await expect(matches).toBeEnabled();
    if (!moved) {
      await expect(matches).not.toHaveValue(/\.mkv/);
      continue;
    }
    await matches.fill(`s02e0${index + 1}`);
    const options = page.getByRole('option', { name: /\.mkv/ });
    await expect(options).toHaveCount(1);
    await options.filter({ hasText: files[index]! }).click();
    await expect(matches).toHaveValue(new RegExp(`S02E0${index + 1}`));
    expect(await matches.getAttribute('title')).toContain(files[index]!);
    await expect(matches).toHaveCSS('text-overflow', 'ellipsis');
    expect(await widths()).toEqual(initialWidths);
    for (const [field, cell] of [[input, cells.nth(1)], [matches, cells.last()]] as const) {
      const [control, bounds] = await Promise.all([field.boundingBox(), cell.boundingBox()]);
      expect(control!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
      expect(control!.x + control!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
    }
  }
  expect(requests).toEqual([]);
  expect(await entry(unselected.id)).toEqual(unselectedBefore);
  await applyMapping(page, panel, 'Do you want to search for these new seasons?');
  await expect(panel).toBeHidden();
  const selected = missing.slice(0, -1);
  expect((await stack.call('GET', `/library/${title.key}`)).body.title.numbering.ranges).toEqual([
    { season: 1, from: 6, to: 9, releaseSeason: 2, releaseFrom: 1 },
  ]);
  await expectMappings(requests, selected.map((target, index) => ({
    id: selected.map(({ id }) => id), source: 'download', hash, file: files[index]!,
    covers: [{ season: 1, number: target.number! }], ids: [target.id],
  })));
  const catalogSeason = page.locator(`[data-row="group:${title.key}:1"]`);
  await expect(catalogSeason).toContainText('Season 1');
  await expect(page.locator(`[data-row="group:${title.key}:2"]`)).toHaveCount(0);
  await catalogSeason.click();
  await page.getByRole('button', { name: 'Show episodes of Season 1', exact: true }).click();
  const seasonEpisodes = page.getByRole('table', { name: 'Episodes of season 1', exact: true });
  for (const [index, target] of selected.entries()) {
    await expect(seasonEpisodes.locator(`[data-row="entry:${target.id}"]`)).toContainText(`Show Name S02E0${index + 1}`);
  }
  await expect(seasonEpisodes.getByRole('row')).toHaveCount(available.length + missing.length + 1);
  expect((await stack.call('POST', '/queue/pause', { paused: false })).status).toBe(200);
  for (const target of selected) {
    await expect.poll(async () => (await entry(target.id)).status, { timeout: 60_000 }).toBe('available');
  }
  await expect.poll(async () => (await entry(available[0]!.id)).status).toBe('available');
  expect(await Promise.all(available.slice(1).map((item) => entry(item.id)))).toEqual(before.slice(1));
  expect(await entry(unselected.id)).toEqual(unselectedBefore);
  const imported = (await stack.call('GET', filesPath)).body.files as Data['files'][string][];
  expect(imported).toHaveLength(9);
  for (const file of filesBefore) {
    expect(imported.find(({ id }) => id === file.id)).toEqual(file);
    expect(readFileSync(join(stack.folders.tv, file.path), 'utf8')).toBe(`first-part-${file.episodes[0]!.number}`);
  }
  for (const [index, target] of selected.entries()) {
    const file = imported.find(({ episodes }) => episodes.some(({ number }) => number === target.number));
    expect(file?.episodes).toEqual([{ season: 1, number: target.number }]);
  expect(readFileSync(join(stack.folders.tv, file!.path), 'utf8')).toBe(secondFiles[files[index]!]);
  }
  await page.goto(`${URL_BASE}/catalog/tv/1`);
  await expect(page.getByText('Manual mapping', { exact: true })).toBeVisible();
  await expect(page.getByText('S01E06–S01E09 → S02E01–S02E04', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show episodes of Season 1', exact: true }).click();
  const firstTable = page.getByRole('region', { name: 'Season 1', exact: true }).getByRole('table', { name: 'Episodes' });
  const importedFirst = firstTable.locator('[data-row="1x1"]');
  await expect(importedFirst.getByRole('cell', { name: 'Episode 1', exact: true })).toBeVisible();
  await expect(importedFirst.getByText('Available', { exact: true })).toBeVisible();
  await expect(firstTable.getByRole('cell', { name: 'Episode 6', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show episodes of Season 2', exact: true }).click();
  const secondTable = page.getByRole('region', { name: 'Season 2', exact: true }).getByRole('table', { name: 'Episodes' });
  await expect(secondTable.getByRole('row')).toHaveCount(5);
  await expect(secondTable.getByRole('row').filter({ hasText: 'Episode 6' }).getByRole('cell', { name: '1', exact: true })).toBeVisible();
  await expect(secondTable.getByText('Available', { exact: true })).toHaveCount(4);
  expect(stack.tracker.state.downloads).toEqual([]);
  expect(stack.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
});

test('applies one external file to two seasons and a separate file to one episode', async ({ page }) => {
  const first = blocked('tv:3', 1, 1, 'importing', 'pack_partial');
  const second = blocked('tv:3', 2, 3, 'importing', 'pack_partial');
  const third = blocked('tv:3', 2, 4, 'importing', 'pack_partial');
  const blank = blocked('tv:3', 1, 2, 'importing', 'pack_partial');
  const unrelated = blocked('tv:1', 1, 1, 'importing', 'pack_partial');
  const name = 'Two.Seasons.S01-S02.Complete.1080p.WEB-DL-GRP';
  const shared = 'Combined chapters.mkv';
  const separate = 'Closing chapter.mkv';
  const hash = completeTorrent(name, { [shared]: 'combined-video', [separate]: 'closing-video' }, '');
  data.queuePaused = true;
  await start([first, second, third, blank, unrelated]);
  const untouched = () => Promise.all([entry(blank.id), entry(unrelated.id)]);
  const before = await untouched();
  const requests = matchRequests(page);
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /^\/api\/(queue|library|mapping)\//.test(new URL(request.url()).pathname)) posts.push(request.url());
  });

  await open(page, 'group:tv:3:2');
  await page.getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Two Seasons (2021)', exact: true });
  const table = panel.getByRole('table', { name: 'Map episodes', exact: true });
  const firstSeason = seasonButton(table, 1);
  const secondSeason = seasonButton(table, 2);
  const episodes = table.getByRole('table', { name: /^Episodes of season / });
  const row = (label: string) => episodes.getByRole('row').filter({ has: page.getByRole('cell', { name: label, exact: true }) });
  const matches = (label: string) => row(label).getByRole('cell').last().getByRole('combobox');
  const torrent = (label: string) => row(label).getByRole('combobox', { name: 'Torrent' });
  const selectTorrent = async (label: string) => {
    await torrent(label).fill('complete');
    await page.getByRole('option', { name, exact: true }).click();
  };
  const selectFile = async (label: string, file: string) => {
    await matches(label).fill(file.split(' ')[0]!);
    await expect(page.getByRole('option', { name: /\.mkv/ })).toHaveCount(1);
    await page.getByRole('option').filter({ hasText: file }).click();
  };
  await expect(firstSeason).toHaveAttribute('aria-expanded', 'false');
  await expect(secondSeason).toHaveAttribute('aria-expanded', 'true');
  await expect(table.getByRole('row', { name: 'Season 1 (2)', exact: true })).toBeVisible();
  await expect(row('S01E01')).toBeHidden();
  await expect(row('S02E03')).toBeVisible();
  const firstSeasonRow = table.getByRole('row', { name: 'Season 1 (2)', exact: true });
  const seasonColor = await firstSeasonRow.evaluate((row) => getComputedStyle(row).backgroundColor);
  await firstSeason.press('Enter');
  await expect(firstSeasonRow).toHaveCSS('background-color', seasonColor);
  await expect(firstSeason).toHaveAttribute('aria-expanded', 'true');
  await expect(episodes.getByRole('cell', { name: /^S\d+E\d+$/ })).toHaveText(['S01E01', 'S01E02', 'S02E03', 'S02E04']);
  await expect(seasonTable(panel, 2).locator('xpath=ancestor::td[1]')).toHaveCSS('background-color', 'rgb(31, 32, 33)');
  for (const field of await row('S02E03').getByRole('combobox').all()) {
    await expect(field).toHaveCSS('background-color', 'rgb(52, 56, 58)');
  }
  await expectFooter(panel);

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const externalFiles = (url: URL) => url.pathname.endsWith('/files') && url.searchParams.get('hash') === hash;
  await page.route(externalFiles, async (route) => { await held; await route.continue(); }, { times: 1 });
  try {
    await Promise.all([page.waitForRequest((req) => externalFiles(new URL(req.url()))), selectTorrent('S02E03')]);
    const field = matches('S02E03');
    await expect(field).toBeVisible();
    await expect(field).toBeEnabled();
    await expect(field).toHaveCSS('border-image-source', 'none');
    await expect(field).not.toHaveCSS('text-decoration-line', /line-through/);
  } finally {
    release();
  }
  await selectFile('S02E03', shared);
  await selectTorrent('S02E04');
  await selectFile('S02E04', separate);
  await selectTorrent('S01E01');
  await selectFile('S01E01', shared);
  await expect(torrent('S02E03')).toHaveValue(name);
  await expect(matches('S02E03')).toHaveValue(/Combined chapters\.mkv/);
  await expect(matches('S02E04')).toHaveValue(/Closing chapter\.mkv/);
  await expect(torrent('S01E01')).toHaveValue(name);
  await expect(matches('S01E01')).toHaveValue(/Combined chapters\.mkv/);
  await expect(matches('S01E02')).not.toHaveValue(/\.mkv/);
  expect(posts).toEqual([]);
  const filesPath = '/library/tv:3/files';
  expect((await stack.call('GET', filesPath)).body.files).toHaveLength(0);

  await secondSeason.click();
  await expect(row('S02E03')).toBeHidden();
  await expect(matches('S01E01')).toHaveValue(/Combined chapters\.mkv/);
  await secondSeason.press('Space');
  await expect(matches('S02E04')).toHaveValue(/Closing chapter\.mkv/);
  await secondSeason.click();
  await applyMapping(page, panel);
  await expect.poll(async () => (await entry(first.id)).status).toBe('importing');
  expect((await entry(second.id)).status).toBe('importing');
  expect((await entry(blank.id)).status).toBe('stuck');
  await expect(panel).toBeHidden();
  const both = [{ season: 1, number: 1 }, { season: 2, number: 3 }];
  const last = [{ season: 2, number: 4 }];
  expect(requests).toHaveLength(4);
  const forFile = (file: string) => requests.filter((request) => request.postDataJSON().file === file);
  const sharedRequests = forFile(shared);
  await expectMappings(sharedRequests, [
    { id: [first.id, second.id], source: 'download', hash, file: shared, covers: both, ids: [first.id, second.id] },
  ]);
  await expectMappings(forFile(separate), [{ id: third.id, source: 'download', hash, file: separate, covers: last, ids: [third.id] }]);
  expect((await entry(third.id)).status).toBe('importing');
  const seasonStatuses = await Promise.all([1, 2].map(async (season) => (await stack.call('GET', `/queue/groups/tv:3?season=${season}`)).body.group.status));
  expect.soft(seasonStatuses).toEqual(['importing', 'importing']);
  expect((await stack.call('POST', '/queue/pause', { paused: false })).status).toBe(200);
  for (const target of [first, second, third]) {
    await expect.poll(async () => (await entry(target.id)).status, { timeout: 60_000 }).toBe('available');
  }
  expect((await stack.call('GET', '/queue/groups/tv:3?season=1')).body.group.status).toBe('stuck');
  const files = (await stack.call('GET', filesPath)).body.files as Data['files'][string][];
  expect(files).toHaveLength(2);
  for (const [contents, coverage] of [['combined-video', both], ['closing-video', last]] as const) {
    const file = files.find((item) => readFileSync(join(stack.folders.tv, item.path), 'utf8') === contents);
    expect(file?.episodes).toHaveLength(coverage.length);
    expect(file!.episodes).toEqual(expect.arrayContaining(coverage));
  }
  expect(await untouched()).toEqual(before);
  expect((await stack.call('GET', '/library/tv:1/files')).body.files).toHaveLength(0);
});

test('shows the file that matches each episode of a season that is not the stopped one', async ({ page }) => {
  const stopped = blocked('tv:3', 1, 1, 'importing', 'file_unmapped');
  const available = blocked('tv:3', 2, 3, 'importing', 'file_unmapped');
  available.state = { kind: 'available' };
  const name = 'Two.Seasons.S02.1080p.WEB-DL-GRP';
  download(available, name, { 'Two.Seasons.S02E03.mkv': 'third' });
  await start([stopped, available]);

  await open(page, 'group:tv:3:1');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Two Seasons (2021)', exact: true });
  await seasonButton(panel, 2).click();
  const table = seasonTable(panel, 2);
  await expect(table.getByRole('row')).toHaveCount(3);
  const cell = (label: string) => table.getByRole('row').filter({ hasText: label }).getByRole('cell').last();
  const shown = cell('S02E03');
  await expect(shown.getByRole('combobox')).toHaveValue(/Two\.Seasons\.S02E03\.mkv/);
  await expect(shown.getByRole('combobox')).toBeEnabled();
  await expect(cell('S02E04').getByRole('combobox')).toHaveValue('');
});

test('reads the files of the torrent while the map dialog loads its mapping', async ({ page }) => {
  const first = blocked('tv:3', 2, 3, 'importing', 'pack_partial');
  const second = blocked('tv:3', 2, 4, 'importing', 'pack_partial');
  const name = 'Two.Seasons.S02.1080p.WEB-DL-GRP';
  download(first, name, { 'Two.Seasons.S02E03.mkv': 'third', 'Two.Seasons.S02E04.mkv': 'fourth' });
  Object.assign(second, { transferHash: first.transferHash, clientId: first.clientId, release: structuredClone(first.release) });
  data.queuePaused = true;
  await start([first, second]);

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const mapping = (url: URL) => url.pathname === '/api/queue/groups/tv:3' && url.searchParams.get('mapping') === 'true';
  await page.route(mapping, async (route) => { await held; await route.continue(); }, { times: 1 });
  try {
    await open(page, 'group:tv:3:2');
    const files = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/files') && url.searchParams.get('source') === 'download';
    });
    const library = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/library/tv:3/files');
    await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
    await Promise.all([files, library]);
  } finally {
    release();
  }
  await expect(page.getByRole('dialog').getByRole('table', { name: 'Map episodes', exact: true })).toBeVisible();
});

test('shows the map dialog only after every torrent and its match load', async ({ page }) => {
  const first = blocked('tv:3', 2, 3, 'importing', 'file_unmapped');
  const second = blocked('tv:3', 2, 4, 'importing', 'file_unmapped');
  download(first, 'Two.Seasons.S02E03.1080p.WEB-DL-GRP', { 'Two.Seasons.S02E03.mkv': 'third' });
  download(second, 'Two.Seasons.S02E04.1080p.WEB-DL-GRP', { 'Two.Seasons.S02E04.mkv': 'fourth' });
  data.queuePaused = true;
  await start([first, second]);

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const files = (url: URL) => url.pathname === `/api/queue/entries/${second.id}/files`;
  let requested = false;
  await page.route(files, async (route) => { requested = true; await held; await route.continue(); }, { times: 1 });
  try {
    await open(page, 'group:tv:3:2');
    await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
    const table = page.getByRole('dialog').getByRole('table', { name: 'Map episodes', exact: true });
    await expect(table).toBeVisible();
    await expect.poll(() => requested).toBe(true);
    await expect(table.getByText('S02E03', { exact: true })).toHaveCount(0);
    release();
    await expect(seasonButton(table, 2)).toHaveAttribute('aria-expanded', 'true');
    const cells = seasonTable(table, 2).getByRole('row').filter({ hasText: 'S02E04' }).getByRole('cell');
    await expect(cells.getByRole('combobox', { name: 'Torrent', exact: true })).toHaveValue('Two.Seasons.S02E04.1080p.WEB-DL-GRP');
    await expect(cells.last().getByRole('combobox', { name: 'Matches' })).toHaveValue(/Two\.Seasons\.S02E04\.mkv/);
  } finally {
    release();
  }
});

test('shows verified torrent matches and ignores a torrent that never reached the client', async ({ page }) => {
  const title = data.titles['tv:1']!;
  title.folder = 'Show Name (2020)';
  const imported = blocked(title.key, 1, 1, 'importing', 'pack_partial');
  const local = blocked(title.key, 1, 2, 'importing', 'pack_partial');
  const stopped = blocked(title.key, 1, 3, 'importing', 'pack_partial');
  const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
  download(imported, name, { 'Show.Name.S01E01.mkv': 'first' });
  Object.assign(local, { transferHash: imported.transferHash, clientId: imported.clientId, release: structuredClone(imported.release) });
  const missing = 'Show.Name.S01.Missing.1080p.WEB-DL-GRP';
  Object.assign(stopped, { transferHash: hashOf(missing), clientId: imported.clientId, release: { ...imported.release!, title: missing, infoHash: hashOf(missing) } });
  const alternate = completeTorrent('Show.Name.S01.Alternate.1080p.WEB-DL-GRP', { 'Show.Name.S01E02.mkv': 'second', 'Show.Name.S01E03.mkv': 'third' });
  mkdirSync(join(stack.folders.tv, title.folder), { recursive: true });
  for (const target of [imported, local]) {
    const file = `Show.Name.S01E0${target.number}.mkv`;
    const path = `${title.folder}/${file}`;
    const abs = join(stack.folders.tv, path);
    if (target === imported) linkSync(join(stack.folders.downloads, name, file), abs);
    else writeFileSync(abs, 'local');
    target.importResult = { at: Date.now(), ok: true, method: 'hardlink', path, validation: 'basic' };
    target.state = { kind: 'available' };
    const { size, mtimeMs } = statSync(abs);
    data.files[file] = { id: file, titleKey: title.key, path, sizeBytes: size, mtimeMs, episodes: [{ season: 1, number: target.number! }], missing: false, addedAt: Date.now(),
      association: { source: 'automatic', originalName: path, numberingRevision: 0, identity: { sizeBytes: size, mtimeMs } } };
    title.episodes.find((episode) => episode.number === target.number)!.fileId = file;
  }
  data.queuePaused = true;
  await start([imported, local, stopped]);
  const requests = matchRequests(page);

  await open(page, `group:${title.key}:1`);
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const panel = page.getByRole('dialog');
  const row = (episode: string) => seasonTable(panel, 1).getByRole('row').filter({ hasText: episode });
  const torrent = (episode: string) => row(episode).getByRole('combobox', { name: 'Torrent' });
  const match = (episode: string) => row(episode).getByRole('combobox', { name: 'Matches' });
  await expect(torrent('S01E01')).toHaveValue(name);
  await expect(match('S01E01')).toHaveValue(/Show\.Name\.S01E01\.mkv/);
  await expect(torrent('S01E02')).toHaveValue('');
  await expect(match('S01E02')).toHaveValue(/Show\.Name\.S01E02\.mkv/);
  await torrent('S01E02').fill('Alternate');
  await page.getByRole('option', { name: /S01\.Alternate/ }).click();
  await expect(match('S01E02')).toHaveValue(/Show\.Name\.S01E02\.mkv/);
  await expect(torrent('S01E03')).toHaveValue('');
  await expect(torrent('S01E03')).toBeEnabled();
  await expect(match('S01E03')).toBeEnabled();
  await torrent('S01E03').fill('Alternate');
  await page.getByRole('option', { name: /S01\.Alternate/ }).click();
  await expect(match('S01E03')).toHaveValue(/Show\.Name\.S01E03\.mkv/);
  await expect(match('S01E03')).toBeEnabled();
  await applyMapping(page, panel);
  await expect(panel).toBeHidden();
  await expectMappings(requests, [local, stopped].map((target) => ({
    id: target.id, hash: alternate, source: 'download', file: `Show.Name.S01E0${target.number}.mkv`, covers: [{ season: 1, number: target.number! }], ids: [target.id],
  })));
});

test('changes the torrent of a mapped episode without a queue entry', async ({ page }) => {
  const title = data.titles['tv:3']!;
  title.folder = 'Two Seasons (2021)';
  title.seasonOverrides['1'] = 'unmonitored';
  const name = 'Two.Seasons.S02.1080p.WEB-DL-GRP';
  const hash = completeTorrent(name, { 'Two.Seasons.S02E03.mkv': 'third' });
  const folder = `${title.folder}/Season 02`;
  const rel = `${folder}/Two.Seasons.S02E03.mkv`;
  mkdirSync(join(stack.folders.tv, folder), { recursive: true });
  writeFileSync(join(stack.folders.tv, rel), 'third');
  const { size, mtimeMs } = statSync(join(stack.folders.tv, rel));
  const episode = title.episodes.find((episode) => episode.season === 2 && episode.number === 3)!;
  data.files.imported = {
    id: 'imported', titleKey: title.key, path: rel, sizeBytes: size, mtimeMs,
    episodes: [{ season: 2, number: 3 }], missing: false, addedAt: Date.now(),
    download: { hash, clientId: data.downloadClients[0]!.id, external: false },
    association: { source: 'automatic', originalName: 'Two.Seasons.S02E03.mkv', numberingRevision: 0, identity: { sizeBytes: size, mtimeMs } },
  };
  episode.fileId = 'imported';
  const alternate = completeTorrent('Two.Seasons.S02.1080p.WEB-DL-Alternate', { 'Replacement.mkv': 'replacement' });
  const second = blocked('tv:3', 2, 4, 'importing', 'pack_partial');
  await start([second]);

  await open(page, 'group:tv:3:2');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(seasonButton(dialog, 2)).toHaveAttribute('aria-expanded', 'true');
  const table = seasonTable(dialog, 2);
  const cells = table.getByRole('row').filter({ hasText: 'S02E03' }).getByRole('cell');
  const torrent = cells.getByRole('combobox', { name: 'Torrent', exact: true });
  await expect(torrent).toHaveValue(name);
  await expect(torrent).toBeEnabled();
  const match = cells.last().getByRole('combobox', { name: 'Matches' });
  await expect(match).toHaveValue(/Two\.Seasons\.S02E03\.mkv/);
  await expect(match).toBeEnabled();
  await torrent.fill('Alternate');
  await page.getByRole('option', { name: 'Two.Seasons.S02.1080p.WEB-DL-Alternate' }).click();
  await expect(match).toHaveValue('');
  await match.click();
  await page.getByRole('option', { name: /Replacement\.mkv/ }).click();
  expect((await stack.call('GET', '/queue/entries/tv:3:2x3')).status).toBe(404);
  await applyMapping(page, page.getByRole('dialog'));
  await expect(table).toBeHidden();
  await expect.poll(async () => (await stack.call('GET', '/queue/groups/tv:3?mapping=true')).body.mapping
    .find((point: { id: string }) => point.id === 'tv:3:2x3')).toMatchObject({ torrent: { hash: alternate }, match: { file: 'Replacement.mkv' } });
});

test('counts only episodes with missing files in the season message', async ({ page }) => {
  const first = blocked('tv:1', 1, 1, 'importing', 'file_not_found');
  const second = blocked('tv:1', 1, 2, 'importing', 'file_not_found');
  const third = blocked('tv:1', 1, 3, 'importing', 'file_unmapped');
  download(first, 'Show.Name.S01.1080p.WEB-DL-GRP', { 'Show.Name.S01E03.mkv': 'third' });
  Object.assign(second, { transferHash: first.transferHash, clientId: first.clientId, release: first.release });
  data.queuePaused = true;
  await start([first, second, third]);

  await open(page, 'group:tv:1:1');
  await expect(page.getByRole('main').getByText('The downloaded torrent does not contain files for 2 episodes.', { exact: true })).toBeVisible();
});

test('opens the mapping with both source packs and keeps their file paths after a restart without the torrents', async ({ page }) => {
  const title = data.titles['tv:3']!;
  title.folder = 'Two Seasons (2021)';
  const packs = [
    { season: 1, number: 1, name: 'First pack', file: 'Disc A/First.mkv' },
    { season: 2, number: 3, name: 'Second pack', file: 'Disc B/Third.mkv' },
  ];
  mkdirSync(join(stack.folders.tv, title.folder), { recursive: true });
  for (const pack of packs) {
    completeTorrent(pack.name, { [pack.file]: 'video' });
    const path = `${title.folder}/Local ${pack.number}.mkv`;
    const dest = join(stack.folders.tv, path);
    linkSync(join(stack.folders.downloads, pack.name, pack.file), dest);
    const { size, mtimeMs, dev, ino } = statSync(dest);
    const point = title.episodes.find((one) => one.season === pack.season && one.number === pack.number)!;
    point.fileId = path;
    data.files[path] = { id: path, titleKey: title.key, path, sizeBytes: size, mtimeMs, missing: false, addedAt: Date.now(),
      episodes: [{ season: point.season, number: point.number }],
      association: { source: 'manual', originalName: path, numberingRevision: 0, identity: { sizeBytes: size, mtimeMs, dev, ino } } };
  }
  data.queuePaused = true;
  const missing = blocked(title.key, 1, 2, 'importing', 'file_not_found');
  missing.transferHash = hashOf(packs[0]!.name);
  missing.clientId = data.downloadClients[0]!.id;
  await start([missing]);
  await open(page, `group:${title.key}:1`);
  await expect(page.getByRole('main').getByText('The downloaded torrent does not contain a file for 1 episode.', { exact: true })).toBeVisible();
  const show = async () => {
    await page.getByRole('button', { name: 'Map episodes manually', exact: true }).click();
    await seasonButton(page.getByRole('dialog'), 2).click();
    for (const [i, label] of ['S01E01', 'S02E03'].entries()) {
      const row = seasonTable(page.getByRole('dialog'), packs[i]!.season).getByRole('row').filter({ hasText: label });
      await expect(row.getByRole('combobox', { name: 'Torrent' })).toHaveValue(packs[i]!.name);
      await expect(row.getByRole('combobox', { name: 'Matches' })).toHaveValue(packs[i]!.file);
    }
  };
  await show();
  const absent = seasonTable(page.getByRole('dialog'), 1).getByRole('row').filter({ hasText: 'S01E02' });
  await expect(absent.getByRole('combobox', { name: 'Torrent' })).toHaveValue(packs[0]!.name);
  await expect(absent.getByRole('combobox', { name: 'Matches' })).toHaveValue('');
  await stack.server.stop();
  stack.qbit.torrents.clear();
  await stack.server.start();
  await open(page, `group:${title.key}:1`);
  await show();
});

test('applies the file that the matcher gives to each episode of a stopped season', async ({ page }) => {
  const first = blocked('tv:3', 2, 3, 'importing', 'file_unmapped');
  const second = blocked('tv:3', 2, 4, 'importing', 'file_unmapped');
  const name = 'Two.Seasons.S02.1080p.WEB-DL-GRP';
  download(first, name, { 'Two.Seasons.S02E03.mkv': 'third', 'Two.Seasons.S02E04.mkv': 'fourth', 'Alternate.mkv': 'alternate' });
  Object.assign(second, { transferHash: first.transferHash, clientId: first.clientId, release: structuredClone(first.release) });
  data.queuePaused = true;
  await start([first, second]);
  const requests = matchRequests(page);

  await open(page, 'group:tv:3:2');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Two Seasons (2021)', exact: true });
  await expect(seasonButton(panel, 2)).toHaveAttribute('aria-expanded', 'true');
  const table = seasonTable(panel, 2);
  const cells = (label: string) => table.getByRole('row').filter({ hasText: label }).getByRole('cell');
  await expect(cells('S02E03').getByRole('combobox', { name: 'Torrent', exact: true })).toHaveValue(name);
  await expect(table.getByRole('button', { name: /^Discard episode / })).toHaveCount(0);
  const third = cells('S02E03').getByRole('combobox', { name: 'Matches' });
  await expect(third).toHaveValue(/Two\.Seasons\.S02E03\.mkv/);
  await expect(cells('S02E04').getByRole('combobox', { name: 'Matches' })).toHaveValue(/Two\.Seasons\.S02E04\.mkv/);
  await third.fill('Alternate');
  await page.getByRole('option', { name: /Alternate\.mkv/ }).click();
  expect(requests).toEqual([]);
  await applyMapping(page, panel);
  await expect(panel).toBeHidden();
  await expectMappings(requests, [
    { id: first.id, source: 'download', file: 'Alternate.mkv', covers: [{ season: 2, number: 3 }], ids: [first.id] },
    { id: second.id, source: 'download', file: 'Two.Seasons.S02E04.mkv', covers: [{ season: 2, number: 4 }], ids: [second.id] },
  ]);
  expect((await entry(first.id)).manualMatch).toEqual({ file: 'Alternate.mkv', covers: [{ season: 2, number: 3 }] });
  expect((await entry(second.id)).manualMatch).toEqual({ file: 'Two.Seasons.S02E04.mkv', covers: [{ season: 2, number: 4 }] });
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
  download(stopped, 'Two.Seasons.S01.1080p.WEB-DL-GRP', { 'New segment.mkv': 'first episode' });
  await start([stopped, available, outside]);
  const outsideBefore = await entry(outside.id);
  const availableBefore = await entry(available.id);
  const before = (await stack.call('GET', '/library/tv:3/files')).body.files;
  const requests = matchRequests(page);

  await open(page, 'group:tv:3:1');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel).toHaveAccessibleName('Two Seasons (2021)');
  await seasonButton(panel, 2).click();
  const table = panel.getByRole('table', { name: /^Episodes of season / });
  await expect(table.getByRole('cell', { name: /^S\d+E\d+$/ })).toHaveCount(4);
  for (const label of ['S01E01', 'S01E02', 'S02E03', 'S02E04']) {
    await expect(table.getByText(label, { exact: true })).toHaveCount(1);
  }
  await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  const mapped = table.getByRole('row').filter({ hasText: 'S01E02' });
  await expect(mapped.getByRole('combobox', { name: 'Torrent', exact: true })).toHaveValue('');
  await expect(mapped.getByRole('combobox', { name: 'Matches' })).toHaveValue('Segments.mkv');
  await expect(table.getByRole('row').filter({ hasText: 'S02E03' }).getByRole('combobox', { name: 'Matches' })).toHaveValue('Segments.mkv');
  await expect(table.getByRole('row').filter({ hasText: 'S02E04' }).getByRole('combobox', { name: 'Matches' })).toHaveValue('');
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await table.getByRole('row').filter({ hasText: 'S01E01' }).getByRole('cell').last().getByRole('combobox').click();
  await page.getByRole('option', { name: /New segment\.mkv/ }).click();
  await expect(panel.getByRole('button', { name: 'Preview changes', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  expect(requests).toEqual([]);
  expect((await stack.call('GET', '/library/tv:3/files')).body.files).toEqual(before);
  expect((await entry(stopped.id)).status).toBe('stuck');
  await applyMapping(page, panel);
  await expect(panel).toBeHidden();
  const covers = [{ season: 1, number: 1 }];
  await expectMappings(requests, [{ id: stopped.id, source: 'download', file: 'New segment.mkv', covers, ids: [stopped.id] }]);

  await expect.poll(async () => (await entry(stopped.id)).status, { timeout: 60_000 }).toBe('available');
  const files = (await stack.call('GET', '/library/tv:3/files')).body.files;
  expect(files).toHaveLength(2);
  expect(files.find((file: { path: string }) => file.path === rel)).toEqual(before[0]);
  expect(files.find((file: { path: string }) => file.path !== rel).episodes).toEqual(covers);
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
  expect(stack.qbit.torrents.size).toBe(1);
});

test('releases a fully mapped season when the user confirms its existing matches', async ({ page }) => {
  const title = data.titles['tv:3']!;
  title.folder = 'Two Seasons (2021)';
  const first = blocked(title.key, 1, 1, 'importing', 'file_unmapped');
  const second = blocked(title.key, 1, 2, 'importing', 'file_unmapped');
  const other = blocked(title.key, 2, 3, 'importing', 'file_unmapped');
  const path = `${title.folder}/First.mkv`;
  mkdirSync(join(stack.folders.tv, title.folder), { recursive: true });
  writeFileSync(join(stack.folders.tv, path), 'first');
  const info = statSync(join(stack.folders.tv, path));
  data.files.first = { id: 'first', titleKey: title.key, path, sizeBytes: info.size, mtimeMs: info.mtimeMs, episodes: [{ season: 1, number: 1 }], missing: false, addedAt: Date.now() };
  title.episodes.find((ep) => ep.season === 1 && ep.number === 1)!.fileId = 'first';
  download(second, 'Two.Seasons.S01.1080p.WEB-DL-GRP', { 'First.mkv': 'first', 'Clip.mkv': 'second' });
  data.files.first.download = { hash: second.transferHash!, clientId: second.clientId!, external: false };
  second.manualMatch = { file: 'Clip.mkv', covers: [{ season: 1, number: 2 }] };
  data.queuePaused = true;
  await start([first, second, other]);
  await open(page, `group:${title.key}:1`);
  await page.getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const panel = page.getByRole('dialog');
  const table = seasonTable(panel, 1);
  await expect(table.getByRole('row').filter({ hasText: 'S01E01' }).getByRole('combobox', { name: 'Matches' })).toHaveValue(/First\.mkv/);
  await expect(table.getByRole('row').filter({ hasText: 'S01E02' }).getByRole('combobox', { name: 'Matches' })).toHaveValue(/Clip\.mkv/);
  await applyMapping(page, panel);
  await expect(panel).toBeHidden();
  expect((await stack.call('GET', `/queue/groups/${title.key}?season=1`)).body.group.status).not.toBe('stuck');
  expect((await entry(other.id)).status).toBe('stuck');
  await stack.server.stop();
  await stack.server.start();
  expect((await stack.call('GET', `/queue/groups/${title.key}?season=1`)).body.group.status).not.toBe('stuck');
  expect((await entry(second.id)).manualMatch).toEqual(second.manualMatch);
});

test('keeps a saved mapping and omits a rejected torrent with no assigned file', async ({ page }) => {
  const title = data.titles['tv:1']!;
  title.folder = 'Show Name (2020)';
  const mapped = blocked(title.key, 1, 1, 'fetching', 'file_unmapped');
  const browsed = blocked(title.key, 1, 2, 'fetching', 'file_unmapped');
  const saved = blocked(title.key, 1, 3, 'importing', 'file_unmapped');
  const prior = 'Show.Name.S01.1080p.WEB-DL-SAVED';
  const path = `${title.folder}/Saved.mkv`;
  mkdirSync(join(stack.folders.tv, title.folder), { recursive: true });
  writeFileSync(join(stack.folders.tv, path), 'third');
  const { size, mtimeMs } = statSync(join(stack.folders.tv, path));
  data.files.saved = {
    id: 'saved', titleKey: title.key, path, sizeBytes: size, mtimeMs, episodes: [{ season: 1, number: 3 }],
    missing: false, addedAt: Date.now(),
    download: { hash: hashOf(prior), clientId: data.downloadClients[0]!.id, external: false, name: prior, file: 'Saved.mkv' },
    association: { source: 'manual', originalName: 'Saved.mkv', numberingRevision: 0, identity: { sizeBytes: size, mtimeMs } },
  };
  title.episodes.find(({ number }) => number === 3)!.fileId = 'saved';
  saved.manualMatch = { file: 'Saved.mkv', covers: [{ season: 1, number: 3 }] };
  const used = reject(mapped, 'Show.Name.S01.1080p.WEB-DL-USED', ['Disc/First.mkv']);
  const unused = reject(mapped, 'Show.Name.S01.1080p.WEB-DL-BROWSED', ['Show.Name.S01E02.mkv', 'Untitled.mkv']);
  data.queuePaused = true;
  await start([mapped, browsed, saved]);
  const before = await entry(saved.id);
  const files = async () => (await stack.call('GET', `/library/${title.key}/files`)).body.files;
  const filesBefore = await files();
  await open(page, `group:${title.key}:1`);
  const writes: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /^\/api\/(queue|mapping)\//.test(new URL(request.url()).pathname)) writes.push(request);
  });
  await page.getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const row = (episode: string) => seasonTable(dialog, 1).getByRole('row').filter({ hasText: episode });
  await expect(row('S01E03').getByRole('combobox', { name: 'Matches' })).toHaveValue(/Saved\.mkv/);
  await row('S01E02').getByRole('combobox', { name: 'Torrent' }).click();
  await page.getByRole('option', { name: unused.title, exact: true }).click();
  const matches = row('S01E02').getByRole('combobox', { name: 'Matches' });
  await matches.click();
  await expect(page.getByRole('option', { name: /Show\.Name\.S01E02\.mkv/ })).toBeVisible();
  await page.getByText('S01E02', { exact: true }).click();
  await expect(matches).toHaveValue('');
  await row('S01E01').getByRole('combobox', { name: 'Torrent' }).click();
  await page.getByRole('option', { name: used.title, exact: true }).click();
  await row('S01E01').getByRole('combobox', { name: 'Matches' }).click();
  await page.getByRole('option').filter({ hasText: 'Disc/First.mkv' }).click();
  expect(writes).toEqual([]);
  await applyMapping(page, dialog);
  await expect(dialog).toBeHidden();
  expect(writes).toHaveLength(1);
  expect(new URL(writes[0]!.url()).pathname).toMatch(/^\/api\/queue\/entries\/tv:1:1x\d+\/releases\/map$/);
  expect(writes[0]!.postDataJSON()).toEqual({ torrents: [{
    indexerId: used.indexerId, guid: used.guid, files: [{ file: `${used.title}/Disc/First.mkv`, ids: [mapped.id] }],
  }] });
  expect((await writes[0]!.response())?.ok()).toBe(true);
  expect(await files()).toEqual(filesBefore);
  expect(await entry(saved.id)).toMatchObject({ status: before.status, manualMatch: saved.manualMatch });
  expect((await entry(browsed.id)).manualMatch).toBeNull();
});

for (const at of ['queued', 'searching', 'fetching'] as const) {
  test(`maps only rejected releases for a season stopped at ${at}, also when it has none`, async ({ page }) => {
    const stopped = blocked('tv:3', 2, 3, at, 'pack_partial');
    completeTorrent('Two.Seasons.S02.1080p.WEB-DL-GRP', { 'Two.Seasons.S02E03.mkv': 'third' }, '');
    data.queuePaused = true;
    await start([stopped]);
    const clientLists: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/external')) clientLists.push(request.url());
    });
    await open(page, 'group:tv:3:2');
    const [group] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/queue/groups/tv:3' && new URL(response.url()).searchParams.has('mapping')),
      page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click(),
    ]);
    expect(new URL(group.url()).searchParams.get('mapping')).toBe('rejected');
    const row = seasonTable(page.getByRole('dialog'), 2).getByRole('row').filter({ hasText: 'S02E03' });
    const torrent = row.getByRole('combobox', { name: 'Torrent', exact: true });
    await torrent.click();
    await expect(page.getByText('No options.', { exact: true })).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(0);
    expect(clientLists).toEqual([]);
  });
}

test('offers every rejected release in the mapping, also one of another title', async ({ page }) => {
  const first = blocked('tv:3', 1, 1, 'fetching', 'file_unmapped');
  const second = blocked('tv:3', 2, 3, 'fetching', 'file_unmapped');
  const releases = [first, second].map((target) => ({
    own: reject(target, `Two.Seasons.S0${target.season}.1080p.WEB-DL-GRP`, ['Chapter.mkv']),
    foreign: reject(target, `Other.Show.S0${target.season}.1080p.WEB-DL-GRP`, ['Chapter.mkv']),
  }));
  for (const { foreign } of releases) {
    Object.assign(foreign, { reasons: ['The title of the release is not this title.'], manifestProblem: undefined });
  }
  data.queuePaused = true;
  await start([first, second]);

  await open(page, 'group:tv:3:1');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Two Seasons (2021)', exact: true });
  await seasonButton(dialog, 2).click();
  for (const [index, label] of ['S01E01', 'S02E03'].entries()) {
    await seasonTable(dialog, index + 1).getByRole('row').filter({ hasText: label }).getByRole('combobox', { name: 'Torrent', exact: true }).click();
    const { own, foreign } = releases[index]!;
    await expect(page.getByRole('option')).toHaveCount(2);
    expect((await page.getByRole('option').allTextContents()).sort()).toEqual([own.title, foreign.title].sort());
    await dialog.getByText(label, { exact: true }).click();
    await expect(page.getByRole('option')).toHaveCount(0);
  }
});

test('corrects two saved matches without reimporting the files', async ({ page }) => {
  const title = data.titles['tv:1']!;
  title.folder = 'Show Name (2020)';
  const hash = completeTorrent('Show.Name.S01.1080p.WEB-DL-GRP', { 'A.mkv': 'A.mkv', 'B.mkv': 'B.mkv' });
  for (const [index, file] of ['A.mkv', 'B.mkv'].entries()) {
    const episode = title.episodes[index]!;
    const path = `${title.folder}/${file}`;
    mkdirSync(join(stack.folders.tv, title.folder), { recursive: true });
    writeFileSync(join(stack.folders.tv, path), file);
    const info = statSync(join(stack.folders.tv, path));
    data.files[file] = { id: file, titleKey: title.key, path, sizeBytes: info.size, mtimeMs: info.mtimeMs, episodes: [{ season: 1, number: episode.number }], missing: false, addedAt: Date.now() };
    data.files[file]!.download = { hash, clientId: data.downloadClients[0]!.id, external: false };
    episode.fileId = file;
  }
  const stopped = blocked(title.key, 1, 3, 'importing', 'pack_partial');
  await start([stopped]);
  await open(page, `group:${title.key}:1`);
  await page.getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (const [episode, from, to] of [['S01E01', 'A.mkv', 'B.mkv'], ['S01E02', 'B.mkv', 'A.mkv']] as const) {
    const field = seasonTable(dialog, 1).getByRole('row').filter({ hasText: episode }).getByRole('combobox', { name: 'Matches' });
    await expect(field).toHaveValue(new RegExp(from));
    await field.fill(to);
    await page.getByRole('option').filter({ hasText: to }).click();
  }
  await applyMapping(page, dialog);
  await expect(dialog).toBeHidden();
  const files = (await stack.call('GET', `/library/${title.key}/files`)).body.files;
  expect(files.map((file: { episodes: unknown }) => file.episodes)).toEqual([[{ season: 1, number: 2 }], [{ season: 1, number: 1 }]]);
  expect(stack.tracker.state.downloads).toEqual([]);
});

test('uses one movie file selector and validates only when Apply is clicked', async ({ page }) => {
  const stopped = blocked('movie:2', null, null, 'importing', 'file_not_found');
  download(stopped, MOVIE_RELEASE, { 'Feature A.mkv': 'one', 'Feature B.mkv': 'two' });
  await start([stopped]);
  const requests = matchRequests(page);

  await open(page, 'entry:movie:2');
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: 'Map episodes manually', exact: true })).toHaveCount(0);
  await main.getByRole('button', { name: 'Select file', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('table', { name: 'Map episodes', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('combobox')).toHaveCount(1);
  const apply = panel.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeDisabled();
  await expect(panel.locator(':scope > :last-child > button', { hasText: 'Apply' })).toBeVisible();
  await panel.getByRole('combobox', { name: 'File', exact: true }).click();
  await page.getByRole('option', { name: /Feature B\.mkv/ }).click();
  await expect(panel.getByRole('button', { name: 'Preview changes', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
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
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  const table = seasonTable(panel, 1);
  await expect(table.getByRole('row')).toHaveCount(3);
  await table.getByRole('row').filter({ hasText: 'S01E01' }).getByRole('cell').last().getByRole('combobox').click();
  await expect(page.getByRole('option', { name: /Library alternative\.mkv/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Download alternative\.mkv/ }).click();
  await expect(panel.getByRole('button', { name: 'Preview changes', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  expect(requests).toEqual([]);
  expect((await entry(stopped.id)).status).toBe('stuck');
  expect((await stack.call('GET', '/library/tv:3/files')).body.files).toHaveLength(0);

  await applyMapping(page, panel);
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
    await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
    const panel = page.getByRole('dialog');
    const table = seasonTable(panel, 1);
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(table.locator('td:last-child').getByRole('combobox')).toHaveCount(3);
    const apply = panel.getByRole('button', { name: 'Apply', exact: true });
    await expect(apply).toBeEnabled();
    for (const [label, file] of [
      ['S01E01', /Part A\.mkv/],
      ['S01E02', shared ? /Part A\.mkv/ : /Part B\.mkv/],
    ] as const) {
      await table.getByRole('row').filter({ hasText: label }).getByRole('cell').last().getByRole('combobox').click();
      await page.getByRole('option', { name: file }).click();
    }
    await expect(apply).toBeEnabled();
    expect(requests).toEqual([]);
    expect(await entry(sibling.id)).toEqual(siblingBefore);

    if (!shared) {
      const viewport = page.viewportSize()!;
      const scroller = table.locator('..');
      await expect(table.getByRole('combobox', { name: 'Torrent', exact: true })).toHaveCount(3);
      try {
        for (const width of [320, 375, 414, 768]) {
          await page.setViewportSize({ width, height: viewport.height });
          await expect(panel).toBeInViewport({ ratio: 1 });
          await expectFooter(panel);
          const inputs = table.getByRole('combobox');
          await expect(inputs).toHaveCount(6);
          expect(await inputs.evaluateAll((fields) => fields.every((field) => {
            const bounds = field.closest('td')!.getBoundingClientRect();
            const input = field.getBoundingClientRect();
            return input.width > 0 && input.left >= bounds.left - 1 && input.right <= bounds.right + 1;
          }))).toBe(true);
          if (width === 320) {
            await expect(scroller).toHaveCSS('overflow-x', 'auto');
            await expect.poll(() => scroller.evaluate((element) => {
              element.scrollLeft = element.scrollWidth;
              const bounds = element.getBoundingClientRect();
              return [...element.querySelectorAll(':scope > table > tbody > tr > td:last-child [role="combobox"]')].every((match) => {
                const right = match.getBoundingClientRect().right;
                return right > bounds.left && right <= bounds.right + 1;
              });
            })).toBe(true);
          }
        }
      } finally {
        await page.setViewportSize(viewport);
      }
    }

    await applyMapping(page, panel);
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
  download(stopped, 'Two.Seasons.S01.1080p.WEB-DL-GRP', { 'Existing association.mkv': 'download-video' });
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
    await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
    const panel = page.getByRole('dialog');
    const apply = panel.getByRole('button', { name: 'Apply', exact: true });
    await expect(apply).toBeEnabled();
    const table = seasonTable(panel, 1);
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table.getByText('S01E02', { exact: true })).toHaveCount(1);
    await expect(panel.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('checkbox')).toHaveCount(0);
    await table.getByRole('row').filter({ hasText: 'S01E01' }).getByRole('cell').last().getByRole('combobox').click();
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

test('keeps Use existing file scoped to the original season and library source', async ({ page }) => {
  const stopped = blocked('tv:3', 1, 1, 'importing', 'destination_exists');
  const other = blocked('tv:3', 2, 3, 'importing', 'destination_exists');
  download(stopped, 'Two.Seasons.Complete.1080p.WEB-DL-GRP', { 'Download alternative.mkv': 'download-video' });
  const title = data.titles['tv:3']!;
  title.folder = 'Two Seasons (2021)';
  const rel = `${title.folder}/Season 01/Existing file.mkv`;
  const path = join(stack.folders.tv, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'library-video');
  data.queuePaused = true;
  await start([stopped, other]);
  const before = await entry(other.id);
  const requests = matchRequests(page);
  await open(page, 'group:tv:3:1');
  await page.getByRole('button', { name: 'Use existing file', exact: true }).click();
  const panel = page.getByRole('dialog');
  const table = panel.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Episodes', 'Matches']);
  await expect(seasonPicker(panel)).toHaveCount(0);
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByText('S02E03', { exact: true })).toHaveCount(0);
  // The rows of this mode can not be selected.
  await expect(panel.locator('tr[aria-selected]')).toHaveCount(0);
  await table.getByRole('row').filter({ hasText: 'S01E01' }).getByRole('combobox').click();
  await expect(page.getByRole('option', { name: /Download alternative\.mkv/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Existing file\.mkv/ }).click();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel).toBeHidden();
  await expectMappings(requests, [{ id: stopped.id, file: rel, source: 'library', covers: [{ season: 1, number: 1 }], ids: [stopped.id] }]);
  expect(await entry(other.id)).toEqual(before);
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
  await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await panel.getByRole('combobox', { name: 'File', exact: true }).click();
  await expect(page.getByRole('option', { name: /Download alternative\.mkv/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Movie Name \(2019\)\.mkv/ }).click();
  await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  expect(requests).toEqual([]);
  expect((await entry(stopped.id)).status).toBe('stuck');
  expect(readFileSync(path, 'utf8')).toBe('library-video');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
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

test('shows the failure of Apply inside the dialog', async ({ page }) => {
  const stopped = blocked('tv:3', 1, 1, 'importing', 'file_unmapped');
  download(stopped, 'Two.Seasons.S01.1080p.WEB-DL-GRP', { 'Episode one.mkv': 'first', 'Episode two.mkv': 'second' });
  await start([stopped]);
  await page.route(`**/queue/entries/${stopped.id}/match`, (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'download_not_found' }) }),
  );

  await open(page, 'group:tv:3:1');
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const panel = page.getByRole('dialog');
  await seasonTable(panel, 1).getByRole('row').filter({ hasText: 'S01E01' }).getByRole('cell').last().getByRole('combobox').click();
  await page.getByRole('option', { name: /Episode one\.mkv/ }).click();
  await applyMapping(page, panel);
  await expect(panel.getByRole('alert')).toHaveText('The download folder is not the same as configured as media.');
  await expect(panel).toBeVisible();
  expect((await entry(stopped.id)).status).toBe('stuck');
});

function writesOf(page: Page) {
  const writes: Request[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /^\/api\/(queue|library|mapping)\//.test(new URL(request.url()).pathname)) writes.push(request);
  });
  return writes;
}

const savedNumbering = async (key: string) => (await stack.call('GET', `/library/${key}`)).body.title.numbering;

async function openMapping(page: Page, row = 'group:tv:1:1', name = 'Show Name (2020)') {
  await open(page, row);
  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  return page.getByRole('dialog', { name, exact: true });
}

const openSeries = (page: Page) => openMapping(page, 'group:tv:3:1', 'Two Seasons (2021)');

// Episodes that stop on one download. Its files name no episode.
async function stoppedDownload(key: string, name: string, points: [number, number][]) {
  const entries = points.map(([season, number]) => blocked(key, season, number, 'importing', 'file_unmapped'));
  const first = entries[0]!;
  download(first, name, { 'Part A.mkv': 'first', 'Part B.mkv': 'second' });
  for (const target of entries.slice(1)) {
    Object.assign(target, { transferHash: first.transferHash, clientId: first.clientId, release: structuredClone(first.release) });
  }
  data.queuePaused = true;
  await start(entries);
}

// tv:1 has E01 to E03 in season 1. tv:3 has E01 and E02 in season 1, and E03 and E04 in season 2.
const stoppedShow = () => stoppedDownload('tv:1', 'Show.Name.S01.1080p.WEB-DL-GRP', [[1, 1], [1, 2], [1, 3]]);
const stoppedSeries = () => stoppedDownload('tv:3', 'Two.Seasons.S01.1080p.WEB-DL-GRP', [[1, 1], [1, 2], [2, 3], [2, 4]]);

test('makes a new season from the selected episodes, and saves it only with Apply', async ({ page }) => {
  await stoppedShow();
  const before = await savedNumbering('tv:1');
  const writes = writesOf(page);
  const panel = await openMapping(page);
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E01', 'S01E02', 'S01E03']);
  await expect(newSeason(panel)).toHaveCount(0);
  await selectEpisodes(panel, 'S01E02', 'S01E03');
  await expect(selection(panel)).toHaveText(['S01E02', 'S01E03']);
  // The button is at the bottom left of the dialog, in the row of Apply.
  await expect(newSeason(panel)).toBeInViewport({ ratio: 1 });
  const apply = panel.getByRole('button', { name: 'Apply', exact: true });
  const [dialog, left, right, body] = await Promise.all(
    [panel, newSeason(panel), apply, panel.locator(':scope > :has(table)')].map((item) => item.boundingBox()),
  );
  expect(left!.x - dialog!.x).toBeLessThan(dialog!.width / 4);
  expect(left!.x + left!.width).toBeLessThan(right!.x);
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(1);
  expect(left!.y).toBeGreaterThanOrEqual(body!.y + body!.height - 1);

  await createSeason(panel, '2');
  await expect(panel).toBeVisible();
  for (const season of [1, 2]) await expect(seasonButton(panel, season)).toHaveAttribute('aria-expanded', 'true');
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E01']);
  await expect(labels(seasonTable(panel, 2))).toHaveText(['S02E01', 'S02E02']);
  await expect(selection(panel)).toHaveCount(0);
  await expect(newSeason(panel)).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(await savedNumbering('tv:1')).toEqual(before);

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/library/tv:1', async (route) => {
    if (route.request().method() === 'PATCH') await held;
    await route.continue();
  });
  await selectEpisodes(panel, 'S01E01');
  await expect(selection(panel)).toHaveText(['S01E01']);
  await applyMapping(page, panel, 'Do you want to search for these new seasons?');
  try {
    // While the dialog saves, no row can be selected.
    await expect(panel.locator('tr[aria-selected]')).toHaveCount(0);
  } finally {
    release();
  }
  await expect(panel).toBeHidden();
  expect(writes.map((request) => `${request.method()} ${new URL(request.url()).pathname}`)).toEqual(['PATCH /api/library/tv:1']);
  expect(writes[0]!.postDataJSON()).toEqual({ episodeSeasons: {
    revision: 0, edits: [2, 3].map((number) => ({ season: 1, number, releaseSeason: 2, search: false })),
  } });
  expect(await savedNumbering('tv:1')).toEqual({ revision: 1, ranges: [{ season: 1, from: 2, to: 3, releaseSeason: 2, releaseFrom: 1 }] });

  // Each saved group holds an episode of season 1, so each one starts open.
  await openMapping(page);
  for (const season of [1, 2]) await expect(seasonButton(panel, season)).toHaveAttribute('aria-expanded', 'true');
  await expect(labels(seasonTable(panel, 2))).toHaveText(['S02E01', 'S02E02']);
});

test('discards the draft of the seasons when the dialog closes before Apply', async ({ page }) => {
  await stoppedShow();
  const before = await savedNumbering('tv:1');
  const writes = writesOf(page);
  const panel = await openMapping(page);
  await selectEpisodes(panel, 'S01E02');
  await createSeason(panel, '2', '12');
  await expect(labels(seasonTable(panel, 12))).toHaveText(['S12E01']);
  // An episode that returns to its TMDB season gets its TMDB number again.
  await selectEpisodes(panel, 'S12E01');
  await createSeason(panel, '2', '1');
  await expect(seasonButton(panel, 12)).toHaveCount(0);
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E01', 'S01E02', 'S01E03']);
  await selectEpisodes(panel, 'S01E03');
  await createSeason(panel, '2');
  await expect(labels(seasonTable(panel, 2))).toHaveText(['S02E01']);
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toBeHidden();
  expect(writes).toEqual([]);
  expect(await savedNumbering('tv:1')).toEqual(before);

  await page.getByRole('main').getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E01', 'S01E02', 'S01E03']);
  await expect(seasonButton(panel, 2)).toHaveCount(0);
});

test('removes the rows of a closed group from the selection', async ({ page }) => {
  await stoppedSeries();
  const panel = await openSeries(page);
  await expect(seasonButton(panel, 2)).toHaveAttribute('aria-expanded', 'false');
  await seasonButton(panel, 2).click();
  await expect(newSeason(panel)).toHaveCount(0);
  await selectEpisodes(panel, 'S01E01');
  await expect(newSeason(panel)).toBeVisible();
  await seasonButton(panel, 1).click();
  await expect(newSeason(panel)).toHaveCount(0);

  await seasonButton(panel, 1).click();
  await selectEpisodes(panel, 'S01E01', 'S02E03');
  await seasonButton(panel, 1).click();
  await expect(selection(panel)).toHaveText(['S02E03']);
  await createSeason(panel, '3');
  // The open groups stay, and the target opens.
  await expect(seasonButton(panel, 1)).toHaveAttribute('aria-expanded', 'false');
  for (const season of [2, 3]) await expect(seasonButton(panel, season)).toHaveAttribute('aria-expanded', 'true');
  await expect(labels(seasonTable(panel, 2))).toHaveText(['S02E04']);
  await expect(labels(seasonTable(panel, 3))).toHaveText(['S03E01']);
  await seasonButton(panel, 1).click();
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E01', 'S01E02']);
});

test('selects episodes with the pointer and the keyboard, across the open groups', async ({ page }) => {
  await stoppedSeries();
  const panel = await openSeries(page);
  await seasonButton(panel, 2).click();
  const click = (label: string, ...modifiers: ('ControlOrMeta' | 'Shift')[]) => episodeCell(panel, label).click({ modifiers });
  const expectSelection = (...episodes: string[]) => expect(selection(panel)).toHaveText(episodes);

  await click('S01E02');
  await expectSelection('S01E02');
  await click('S01E01');
  await expectSelection('S01E01');
  await click('S02E04', 'ControlOrMeta');
  await expectSelection('S01E01', 'S02E04');
  await click('S02E04', 'ControlOrMeta');
  await expectSelection('S01E01');
  await click('S01E02');
  await click('S02E03', 'Shift');
  await expectSelection('S01E02', 'S02E03');
  await click('S02E04', 'Shift');
  await expectSelection('S01E02', 'S02E03', 'S02E04');
  await click('S01E01', 'Shift');
  await expectSelection('S01E01', 'S01E02');

  // A control of a row, and an option of its dropdown, keep the selection.
  await episodeRow(panel, 'S02E04').getByRole('combobox', { name: 'Torrent', exact: true }).click();
  await page.getByRole('option', { name: 'Two.Seasons.S01.1080p.WEB-DL-GRP', exact: true }).click();
  await episodeRow(panel, 'S02E04').getByRole('combobox', { name: 'Matches', exact: true }).click();
  await page.getByRole('option', { name: /Part A\.mkv/ }).click();
  await expect(episodeRow(panel, 'S02E04').getByRole('combobox', { name: 'Matches', exact: true })).toHaveValue(/Part A\.mkv/);
  await expectSelection('S01E01', 'S01E02');

  await episodeRow(panel, 'S02E03').press('Space');
  await expectSelection('S01E01', 'S01E02', 'S02E03');
  await episodeRow(panel, 'S02E03').press('Space');
  await expectSelection('S01E01', 'S01E02');
  await episodeRow(panel, 'S02E04').press('Shift+Space');
  await expectSelection('S02E03', 'S02E04');
});

test('numbers a moved episode after the last episode of the season that takes it', async ({ page }) => {
  await stoppedSeries();
  const writes = writesOf(page);
  const panel = await openSeries(page);
  await selectEpisodes(panel, 'S01E01');
  const { modal, season, create } = await openSeasonModal(panel);
  await expect(season).toHaveValue('3');
  // The list of the dropdown works inside the second modal.
  await season.click();
  await page.getByRole('option', { name: '2', exact: true }).click();
  await expect(season).toHaveValue('2');
  await expect(modal).toBeVisible();
  await create.click();
  await expect(modal).toBeHidden();
  await expect(seasonButton(panel, 2)).toHaveAttribute('aria-expanded', 'true');
  // The rows are in the order of their release numbers.
  await expect(labels(seasonTable(panel, 2))).toHaveText(['S02E03', 'S02E04', 'S02E05']);
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E02']);
  await applyMapping(page, panel);
  await expect(panel).toBeHidden();
  expect(writes[0]!.method()).toBe('PATCH');
  expect(writes[0]!.postDataJSON()).toEqual({ episodeSeasons: { revision: 0, edits: [{ season: 1, number: 1, releaseSeason: 2, search: false }] } });
  expect(await savedNumbering('tv:3')).toEqual({ revision: 1, ranges: [{ season: 1, from: 1, to: 1, releaseSeason: 2, releaseFrom: 5 }] });
});

test('returns a saved episode to its TMDB season with its TMDB number', async ({ page }) => {
  data.titles['tv:1']!.numbering = { revision: 1, ranges: [{ season: 1, from: 2, to: 3, releaseSeason: 2, releaseFrom: 1 }] };
  await stoppedShow();
  const writes = writesOf(page);
  const panel = await openMapping(page);
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E01']);
  await expect(labels(seasonTable(panel, 2))).toHaveText(['S02E01', 'S02E02']);
  await selectEpisodes(panel, 'S02E01');
  await createSeason(panel, '3', '1');
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E01', 'S01E02']);
  await expect(labels(seasonTable(panel, 2))).toHaveText(['S02E02']);
  await applyMapping(page, panel);
  await expect(panel).toBeHidden();
  expect(writes[0]!.postDataJSON()).toEqual({ episodeSeasons: { revision: 1, edits: [{ season: 1, number: 2, releaseSeason: 1, search: false }] } });
  expect(await savedNumbering('tv:1')).toEqual({ revision: 2, ranges: [{ season: 1, from: 3, to: 3, releaseSeason: 2, releaseFrom: 2 }] });
});

test('keeps Create disabled for a season that cannot take the selected episodes', async ({ page }) => {
  // S01E01 of TMDB holds the number of S02E04 of TMDB, which is in season 5.
  data.titles['tv:3']!.numbering = { revision: 1, ranges: [
    { season: 1, from: 1, to: 1, releaseSeason: 2, releaseFrom: 4 },
    { season: 2, from: 4, to: 4, releaseSeason: 5, releaseFrom: 1 },
  ] };
  await stoppedSeries();
  const panel = await openSeries(page);
  await expect(labels(seasonTable(panel, 2))).toHaveText(['S02E03', 'S02E04']);
  await seasonButton(panel, 5).click();
  await selectEpisodes(panel, 'S05E01');
  const { season, create } = await openSeasonModal(panel);
  await expect(season).toHaveValue('3');
  const problem = page.getByText('The episode map is not valid. Check the ranges.', { exact: true });
  await typeSeason(season, '2');
  await expect(problem.first()).toBeVisible();
  await expect(create).toBeDisabled();
  await typeSeason(season, 'x');
  await expect(problem).toHaveCount(0);
  await expect(create).toBeDisabled();
  await typeSeason(season, '3');
  await expect(problem).toHaveCount(0);
  await expect(create).toBeEnabled();
});

test('counts the specials for the next free season and for the numbers of a draft', async ({ page }) => {
  const title = data.titles['tv:3']!;
  // A season without names starts a metadata refresh, and the refresh drops the episodes that TMDB does not have.
  title.meta.seasons.push({ seasonNumber: 0, episodeCount: 1, airDate: null, names: { en: null, es: null } });
  title.episodes.push({ ...title.episodes[0]!, tmdbId: 300, season: 0, number: 1, fileId: null });
  title.numbering = { revision: 1, ranges: [{ season: 0, from: 1, to: 1, releaseSeason: 3, releaseFrom: 1 }] };
  await stoppedSeries();
  const panel = await openSeries(page);
  await selectEpisodes(panel, 'S01E01');
  // The table does not show the special, and it holds S03E01.
  await expect(seasonButton(panel, 3)).toHaveCount(0);
  await createSeason(panel, '4', '3');
  await expect(labels(seasonTable(panel, 3))).toHaveText(['S03E02']);
});

test('selects only the episodes that wait for a release among the rejected releases', async ({ page }) => {
  const entries = [1, 2, 3].map((number) => blocked('tv:1', 1, number, 'fetching', 'file_unmapped'));
  entries[2]!.state = { kind: 'available' };
  data.queuePaused = true;
  await start(entries);
  const mapping = page.waitForRequest((request) => new URL(request.url()).searchParams.get('mapping') === 'rejected');
  const panel = await openMapping(page);
  await mapping;
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E01', 'S01E02', 'S01E03']);
  await expect(panel.locator('tr[aria-selected]')).toHaveCount(2);
  await selectEpisodes(panel, 'S01E03');
  await expect(selection(panel)).toHaveCount(0);
  await expect(newSeason(panel)).toHaveCount(0);
  await selectEpisodes(panel, 'S01E01');
  await episodeCell(panel, 'S01E03').click({ modifiers: ['Shift'] });
  await expect(selection(panel)).toHaveText(['S01E01']);
  await episodeCell(panel, 'S01E02').click({ modifiers: ['Shift'] });
  await expect(selection(panel)).toHaveText(['S01E01', 'S01E02']);
  await createSeason(panel, '2');
  await expect(labels(seasonTable(panel, 1))).toHaveText(['S01E03']);
  await expect(labels(seasonTable(panel, 2))).toHaveText(['S02E01', 'S02E02']);
});

for (const open of [false, true]) {
  test(`sends the releases of the season of the entry, and ${open ? 'also' : 'not'} those of another season in ${open ? 'an open' : 'a closed'} group`, async ({ page }) => {
    const targets = ([[1, 1], [1, 2], [2, 3], [2, 4]] as const).map(([season, number]) => blocked('tv:3', season, number, 'fetching', 'file_unmapped'));
    // The releases number E02 of season 1 as season 3, and all of season 2 as season 5.
    data.titles['tv:3']!.numbering = { revision: 1, ranges: [
      { season: 1, from: 2, to: 2, releaseSeason: 3, releaseFrom: 1 },
      { season: 2, from: 3, to: 4, releaseSeason: 5, releaseFrom: 1 },
    ] };
    const releases = targets.map((target, index) => {
      const name = `Two.Seasons.S0${target.season}E0${target.number}.1080p.WEB-DL-GRP`;
      // The first target of a season holds the releases of that season.
      const release = reject(targets[index - (index % 2)]!, name, ['Chapter.mkv']);
      release.matches = { [target.id]: `${name}/Chapter.mkv` };
      return release;
    });
    // The dialog reads each torrent from the indexer, and the default delay between two requests is too long here.
    for (const indexer of Object.values(data.indexers)) indexer.delaySeconds = 0;
    data.queuePaused = true;
    await start(targets);
    const writes = writesOf(page);
    const panel = await openSeries(page);
    const torrent = (label: string) => episodeRow(panel, label).getByRole('combobox', { name: 'Torrent', exact: true });
    // The groups that hold an episode of season 1 start open.
    for (const season of [1, 3]) await expect(seasonButton(panel, season)).toHaveAttribute('aria-expanded', 'true');
    await expect(seasonButton(panel, 5)).toHaveAttribute('aria-expanded', 'false');
    await expect(torrent('S01E01')).toHaveValue(releases[0]!.title);
    await expect(torrent('S03E01')).toHaveValue(releases[1]!.title);
    await seasonButton(panel, 5).click();
    await expect(torrent('S05E01')).toHaveValue(releases[2]!.title);
    await expect(torrent('S05E02')).toHaveValue(releases[3]!.title);
    if (!open) await seasonButton(panel, 5).click();
    // A release of the season of the entry goes also from a closed group.
    await seasonButton(panel, 3).click();
    await applyMapping(page, panel);
    await expect(panel).toBeHidden();
    const sent = writes.flatMap((request) => (request.postDataJSON() as { torrents: { guid: string }[] }).torrents.map(({ guid }) => guid));
    expect(sent.sort()).toEqual((open ? releases : releases.slice(0, 2)).map(({ guid }) => guid).sort());
    for (const request of writes) {
      expect(new URL(request.url()).pathname).toMatch(/\/releases\/map$/);
      expect((await request.response())?.status()).toBe(202);
    }
  });
}
