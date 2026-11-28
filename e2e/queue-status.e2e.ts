import type { BrowserContext, Page, Request } from '@playwright/test';
import type { QueueGroupPage } from '../packages/shared/src/types.ts';
import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';
import { expect, test } from './fixtures.ts';
import { configure, MIB, startStack, URL_BASE } from './stack.ts';

test('stops an ambiguous season for mapping while another season of the same series downloads', async ({ page, context }) => {
  test.setTimeout(120_000);
  const stack = await startStack();
  try {
    const cookie = await stack.createOwner();
    await context.addCookies([{ ...cookie, url: URL_BASE }]);
    await configure(stack);
    const ambiguous = { title: 'Two.Seasons.S01.1080p.WEB-DL-GRP', size: 2 * 60 * 45 * MIB, files: ['First chapter.mkv', 'Second chapter.mkv'] };
    const complete = { title: 'Two.Seasons.S02.1080p.WEB-DL-GRP', size: 2 * 60 * 45 * MIB, files: ['Two.Seasons.S02E03.mkv', 'Two.Seasons.S02E04.mkv'] };
    stack.tracker.state.items = [ambiguous, complete];
    stack.tracker.state.answer = (url) => {
      if (url.searchParams.has('ep')) return [];
      switch (url.searchParams.get('season')) {
        case '1': return [ambiguous];
        case '2': return [complete];
        default: return [];
      }
    };
    expect((await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 3, add: 'future' })).status).toBe(201);
    const addSeason = async (number: number) => {
      await page.goto(`${URL_BASE}/catalog/tv/3`);
      const search = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/queue/search');
      await page.getByRole('button', { name: `Add Season ${number}`, exact: true }).click();
      expect((await search).ok()).toBe(true);
    };
    await addSeason(1);
    await expect.poll(() => stack.tracker.state.downloads, { timeout: 30_000 }).toContain(ambiguous.title);

    await page.goto(`${URL_BASE}/activity`);
    const first = page.locator('[data-row="group:tv:3:1"]');
    const second = page.locator('[data-row="group:tv:3:2"]');
    await expect(first).toContainText('Stuck', { timeout: 45_000 });
    await expect(page.getByRole('main').getByText('The releases available do not contain all the episodes.', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Map episodes manually', exact: true })).toBeVisible();
    expect(stack.tracker.state.downloads).toEqual([ambiguous.title]);
    expect(stack.addRequests()).toHaveLength(0);

    await addSeason(2);
    await expect.poll(() => stack.qbit.torrents.has(hashOf(complete.title, complete.files)), { timeout: 45_000 }).toBe(true);
    expect(stack.tracker.state.downloads).toEqual([ambiguous.title, complete.title]);
    await page.goto(`${URL_BASE}/activity`);
    await expect(first).toContainText('Stuck');
    await expect(second).toContainText('Downloading');
    await page.getByRole('tab', { name: /^Stuck\b/ }).click();
    await expect(first).toBeVisible();
    await expect(second).toHaveCount(0);
    await page.getByRole('button', { name: 'Map episodes manually', exact: true }).click();
    const mapping = page.getByRole('dialog', { name: 'Two Seasons (2021)' });
    await expect(mapping.getByRole('table', { name: 'Map episodes' })).toBeVisible();
    const torrent = mapping.getByRole('combobox', { name: 'Torrent', exact: true }).first();
    await expect(torrent).toHaveValue('');
    await torrent.click();
    await expect(page.getByRole('option', { name: ambiguous.title, exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: complete.title, exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(stack.addRequests()).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(mapping).toBeHidden();
    await page.getByRole('tab', { name: /^Searching\b/ }).click();
    await expect(page.getByText('No target fits these filters.', { exact: true })).toBeVisible();
    await expect(first).toHaveCount(0);
    expect(stack.addRequests()).toHaveLength(1);
  } finally {
    await stack.stop();
  }
});

test('maps explicit files from two rejected releases and sends only those torrents', async ({ page, context }) => {
  test.setTimeout(120_000);
  const stack = await startStack();
  try {
    const cookie = await stack.createOwner();
    await context.addCookies([{ ...cookie, url: URL_BASE }]);
    await configure(stack);
    const pack = (season: number, group: string, files: string[]) => ({
      title: `Two.Seasons.S0${season}.1080p.WEB-DL-${group}`, size: 2 * 60 * 45 * MIB, files,
    });
    const other = pack(1, 'OTHER', ['Other chapter.mkv']);
    const alpha = pack(2, 'ALPHA+GROUP', ['Disc A/Two.Seasons.S02E03.mkv', 'Disc A/Untitled.mkv']);
    const beta = pack(2, 'BETA', ['Disc B/Final chapter.mkv']);
    const unused = pack(2, 'UNUSED', ['Unused chapter.mkv']);
    stack.tracker.state.answer = (url) => url.searchParams.has('ep') ? []
      : url.searchParams.get('season') === '2' ? [alpha, beta, unused] : [other];
    expect((await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 3, add: 'all' })).status).toBe(201);
    const details = async (season: number): Promise<QueueGroupPage> => (await stack.call('GET', `/queue/groups/tv:3?season=${season}`)).body;
    const names = async (season: number) => (await details(season)).group.rejected.map(({ release }) => release.title).sort();
    await expect.poll(() => names(1), { timeout: 45_000 }).toEqual([other.title]);
    await expect.poll(() => names(2), { timeout: 45_000 }).toEqual([alpha.title, beta.title, unused.title].sort());
    const otherSeason = async () => (await details(1)).items.map(({ id, revision, status }) => ({ id, revision, status }));
    const before = await otherSeason();
    const { rejected } = (await details(2)).group;
    await page.goto(`${URL_BASE}/activity`);
    await page.locator('[data-row="group:tv:3:2"]').click();
    const manifests: URL[] = [];
    const writes: Request[] = [];
    const candidateFiles: URL[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/releases/torrent')) manifests.push(url);
      if (/\/queue\/entries\/[^/]+\/(external|files)$/.test(url.pathname)) candidateFiles.push(url);
      if (request.method() === 'POST' && /^\/api\/(queue|mapping)\//.test(url.pathname)) writes.push(request);
    });
    await page.getByRole('button', { name: 'Map episodes manually', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Two Seasons (2021)' });
    const seasonOne = dialog.getByRole('button', { name: 'Season 1', exact: true });
    await expect(seasonOne).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.getByRole('button', { name: 'Season 2', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(dialog.getByRole('table', { name: 'Episodes of season 1' })).toBeHidden();
    const table = dialog.getByRole('table', { name: 'Episodes of season 2' });
    const row = (label: string) => table.getByRole('row').filter({ hasText: label });
    const torrent = (label: string) => row(label).getByRole('combobox', { name: 'Torrent', exact: true });
    const matches = (label: string) => row(label).getByRole('combobox', { name: 'Matches', exact: true });
    for (const label of ['S02E03', 'S02E04']) {
      await expect(torrent(label)).toHaveValue('');
      await expect(matches(label)).toHaveValue('');
    }
    await seasonOne.click();
    await dialog.getByRole('table', { name: 'Episodes of season 1' }).getByRole('combobox', { name: 'Torrent' }).first().click();
    await expect(page.getByRole('option', { name: /^Two\.Seasons/ })).toHaveText([other.title]);
    await page.getByText('S01E01', { exact: true }).click();
    await seasonOne.click();
    await torrent('S02E03').click();
    const options = page.getByRole('option', { name: /^Two\.Seasons/ });
    await expect(options).toHaveCount(3);
    expect((await options.allTextContents()).sort()).toEqual([alpha.title, beta.title, unused.title].sort());
    expect(manifests).toEqual([]);
    expect(candidateFiles).toEqual([]);

    const select = async (label: string, release: typeof alpha) => {
      const item = rejected.find((item) => item.release.title === release.title)!;
      const [manifest] = await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === `/api/queue/entries/${item.entryId}/releases/torrent`
            && url.searchParams.get('indexerId') === String(item.release.indexerId) && url.searchParams.get('guid') === item.release.guid;
        }),
        page.getByRole('option', { name: release.title, exact: true }).click(),
      ]);
      expect(manifest.ok()).toBe(true);
      await expect(matches(label)).toHaveValue('');
      await matches(label).click();
      const files = page.getByRole('option', { name: /\.mkv/ });
      await expect(files).toHaveCount(release.files.length);
      for (const file of release.files) await expect(files.filter({ hasText: file })).toBeVisible();
    };
    await select('S02E03', unused);
    await page.getByRole('option').filter({ hasText: unused.files[0]! }).click();
    await torrent('S02E03').fill(alpha.title);
    await select('S02E03', alpha);
    await page.getByRole('option').filter({ hasText: alpha.files[1]! }).click();
    await torrent('S02E04').click();
    await select('S02E04', beta);
    await page.getByRole('option').filter({ hasText: beta.files[0]! }).click();
    expect(stack.addRequests()).toHaveLength(0);
    const apply = dialog.getByRole('button', { name: 'Apply mapping', exact: true });
    await apply.click();
    const confirmation = page.getByRole('dialog', { name: 'Apply this episode mapping?', exact: true });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(writes).toEqual([]);
    await apply.click();
    await confirmation.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(writes).toHaveLength(1);
    const request = writes[0]!;
    expect(new URL(request.url()).pathname).toMatch(/^\/api\/queue\/entries\/tv:3:2x[34]\/releases\/map$/);
    const expected = [
      { pack: alpha, file: alpha.files[1], id: 'tv:3:2x3' },
      { pack: beta, file: beta.files[0], id: 'tv:3:2x4' },
    ].map(({ pack, file, id }) => {
      const { indexerId, guid } = rejected.find(({ release }) => release.title === pack.title)!.release;
      return { indexerId, guid, files: [{ file: `${pack.title}/${file}`, ids: [id] }] };
    });
    expect(request.postDataJSON()).toEqual({ torrents: expect.arrayContaining(expected) });
    expect(request.postDataJSON().torrents).toHaveLength(2);
    expect((await request.response())?.ok()).toBe(true);
    await expect.poll(() => [...stack.qbit.torrents.keys()].sort(), { timeout: 45_000 }).toEqual(
      [alpha, beta].map(({ title, files }) => hashOf(title, files)).sort(),
    );
    expect(stack.addRequests()).toHaveLength(2);
    expect(await otherSeason()).toEqual(before);
  } finally {
    await stack.stop();
  }
});

const release = (title: string, files: string[], size = files.length * 60 * 45 * MIB) => ({ title, size, files });
const BOTH = release('Show.Name.S01.1080p.WEB-DL-BOTH', ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv']);
const ONE = release('Show.Name.S01E01.1080p.WEB-DL-ONE', ['Show.Name.S01E01.mkv']);
// The checks reject it for its quality, so it holds no episode for the mapping.
const LOW = release('Show.Name.S01E03.480p.WEB-DL-LOW', ['Show.Name.S01E03.mkv'], 20 * 45 * MIB);
const NEXT = release('Show.Name.S02.1080p.WEB-DL-NEXT', ['Show.Name.S02E01.mkv', 'Show.Name.S02E02.mkv']);

// A season of three episodes that stops: one pack holds E01 and E02, one single holds E01, and nothing holds E03.
async function stoppedShow(context: BrowserContext) {
  const stack = await startStack();
  const cookie = await stack.createOwner();
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await configure(stack);
  stack.tracker.state.answer = (url) => {
    if (url.searchParams.has('ep')) return [];
    const season = url.searchParams.get('season');
    return season === '1' ? [BOTH, ONE, LOW] : season === '2' ? [NEXT] : [];
  };
  expect((await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' })).status).toBe(201);
  const group = async (): Promise<QueueGroupPage> => (await stack.call('GET', '/queue/groups/tv:1?season=1')).body;
  await expect.poll(async () => (await group()).group?.rejected.length, { timeout: 45_000 }).toBe(3);
  await expect.poll(async () => (await group()).group.status).toBe('stuck');
  const rejected = (await group()).group.rejected.map(({ release }) => release);
  // The releases that hold each episode, in the order of the rejected list.
  const holders = (number: number) => rejected.map(({ title }) => title)
    .filter((title) => (number === 1 ? [BOTH.title, ONE.title] : number === 2 ? [BOTH.title] : []).includes(title));
  // The body of one torrent of a mapping request.
  const torrent = (title: string, numbers: number[]) => {
    const { indexerId, guid } = rejected.find((item) => item.title === title)!;
    return { indexerId, guid, files: numbers.map((n) => ({ file: `${title}/Show.Name.S01E0${n}.mkv`, ids: [`tv:1:1x${n}`] })) };
  };
  return { stack, holders, torrent };
}

async function openMapping(page: Page) {
  await page.goto(`${URL_BASE}/activity`);
  await page.locator('[data-row="group:tv:1:1"]').click();
  await page.getByRole('button', { name: 'Map episodes manually', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Show Name (2020)', exact: true });
  const row = (number: number) => dialog.getByRole('table', { name: 'Episodes of season 1', exact: true }).getByRole('row').filter({ hasText: `S01E0${number}` });
  const field = (name: string) => (number: number) => row(number).getByRole('combobox', { name, exact: true });
  return { dialog, season: field('Season'), torrent: field('Torrent'), matches: field('Matches') };
}

type Mapping = Awaited<ReturnType<typeof openMapping>>;

// The row of an episode shows this release and its file.
async function expectSelected({ torrent, matches }: Mapping, number: number, title: string) {
  await expect(torrent(number)).toHaveValue(title);
  await expect(matches(number)).toHaveValue(new RegExp(`Show\\.Name\\.S01E0${number}\\.mkv`));
}

async function expectEmpty({ torrent, matches }: Mapping, number: number) {
  await expect(torrent(number)).toHaveValue('');
  await expect(matches(number)).toHaveValue('');
}

async function moveToSeasonTwo(page: Page, { season }: Mapping, number: number) {
  await season(number).fill('2');
  await page.getByRole('option', { name: '2', exact: true }).click();
  await expect(season(number)).toHaveValue('2');
}

function writesOf(page: Page) {
  const writes: Request[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /^\/api\/(queue|library|mapping)\//.test(new URL(request.url()).pathname)) writes.push(request);
  });
  return writes;
}

async function apply(page: Page, { dialog }: Mapping, question: string, season?: string) {
  await dialog.getByRole('button', { name: 'Apply mapping', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: question, exact: true });
  if (season) await confirmation.getByRole('checkbox', { name: season, exact: true }).check();
  await confirmation.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(dialog).toBeHidden();
}

// The torrents and the files of a mapping request, in a fixed order.
type Torrents = { guid: string; files: { file: string }[] }[];
const ordered = (torrents: Torrents) => torrents
  .map((item) => ({ ...item, files: item.files.toSorted((a, b) => a.file.localeCompare(b.file)) }))
  .toSorted((a, b) => a.guid.localeCompare(b.guid));

test('preselects the first rejected release that holds each episode, and maps them with one click', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { stack, holders, torrent } = await stoppedShow(context);
  try {
    const writes = writesOf(page);
    const mapping = await openMapping(page);
    const first = holders(1)[0]!;
    await expectSelected(mapping, 1, first);
    await expectSelected(mapping, 2, BOTH.title);
    await expectEmpty(mapping, 3);
    expect(writes).toEqual([]);

    await apply(page, mapping, 'Apply this episode mapping?');

    expect(writes.map((request) => new URL(request.url()).pathname)).toEqual([expect.stringMatching(/\/releases\/map$/)]);
    const expected = first === BOTH.title ? [torrent(BOTH.title, [1, 2])] : [torrent(ONE.title, [1]), torrent(BOTH.title, [2])];
    expect(ordered(writes[0]!.postDataJSON().torrents)).toEqual(ordered(expected));
    expect((await writes[0]!.response())?.status()).toBe(202);
    const used = first === BOTH.title ? [BOTH] : [ONE, BOTH];
    await expect.poll(() => [...stack.qbit.torrents.keys()].sort(), { timeout: 45_000 }).toEqual(used.map(({ title, files }) => hashOf(title, files)).sort());
  } finally {
    await stack.stop();
  }
});

test('drops the preselection of an episode that changes season, and takes another release that the user chooses', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { stack, holders, torrent } = await stoppedShow(context);
  try {
    const writes = writesOf(page);
    const mapping = await openMapping(page);
    const [first, other] = holders(1) as [string, string];
    await expectSelected(mapping, 1, first);
    await expectSelected(mapping, 2, BOTH.title);

    await moveToSeasonTwo(page, mapping, 2);
    await expectEmpty(mapping, 2);
    await expectSelected(mapping, 1, first);
    await mapping.torrent(1).click();
    await page.getByRole('option', { name: other, exact: true }).click();
    await mapping.matches(1).click();
    await page.getByRole('option').filter({ hasText: 'Show.Name.S01E01.mkv' }).click();
    await expectSelected(mapping, 1, other);
    // The user does not ask to search the new season.
    await apply(page, mapping, 'Do you want to search for these new seasons?');

    expect(writes.map((request) => request.method())).toEqual(['PATCH', 'POST']);
    expect(writes[0]!.postDataJSON().episodeSeasons.edits).toEqual([{ season: 1, number: 2, releaseSeason: 2, search: false }]);
    expect(writes[1]!.postDataJSON().torrents).toEqual([torrent(other, [1])]);
    expect((await writes[1]!.response())?.status()).toBe(202);
    const chosen = [BOTH, ONE].find(({ title }) => title === other)!;
    await expect.poll(() => [...stack.qbit.torrents.keys()], { timeout: 45_000 }).toEqual([hashOf(chosen.title, chosen.files)]);
  } finally {
    await stack.stop();
  }
});

test('searches the episodes that the user moves to another season, and maps the preselected rest', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { stack, holders, torrent } = await stoppedShow(context);
  try {
    // The queue waits, so the mapping arrives before the search of the moved episodes ends.
    expect((await stack.call('POST', '/queue/pause', { paused: true })).status).toBe(200);
    const searched = stack.tracker.state.searches.length;
    const writes = writesOf(page);
    const mapping = await openMapping(page);
    const first = holders(1)[0]!;
    await expectSelected(mapping, 1, first);
    await expectSelected(mapping, 2, BOTH.title);
    for (const number of [2, 3]) await moveToSeasonTwo(page, mapping, number);
    await expectEmpty(mapping, 2);

    await apply(page, mapping, 'Do you want to search for these new seasons?', 'Season 02');

    expect(writes.map((request) => request.method())).toEqual(['PATCH', 'POST']);
    expect(new URL(writes[0]!.url()).pathname).toBe('/api/library/tv:1');
    expect(writes[0]!.postDataJSON().episodeSeasons.edits).toEqual([2, 3].map((number) => ({ season: 1, number, releaseSeason: 2, search: true })));
    expect(writes[1]!.postDataJSON().torrents).toEqual([torrent(first, [1])]);
    expect((await writes[1]!.response())?.status()).toBe(202);

    expect((await stack.call('POST', '/queue/pause', { paused: false })).status).toBe(200);
    const chosen = [BOTH, ONE].find(({ title }) => title === first)!;
    await expect.poll(() => [...stack.qbit.torrents.keys()].sort(), { timeout: 45_000 }).toEqual(
      [chosen, NEXT].map(({ title, files }) => hashOf(title, files)).sort(),
    );
    // The save searches the moved episodes only.
    expect(stack.tracker.state.searches.slice(searched).map((url) => url.searchParams.get('season'))).toEqual(['2']);
  } finally {
    await stack.stop();
  }
});
