import type { Request } from '@playwright/test';
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
