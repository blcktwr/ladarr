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
    await expect(page.getByRole('button', { name: 'Map episodes', exact: true })).toBeVisible();
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
    await page.getByRole('button', { name: 'Map episodes', exact: true }).click();
    const mapping = page.getByRole('dialog', { name: 'Two Seasons (2021)' });
    await expect(mapping.getByRole('table', { name: 'Map episodes' })).toBeVisible();
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
