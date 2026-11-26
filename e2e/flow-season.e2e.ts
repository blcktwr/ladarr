import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';
import { expect, test } from './fixtures.ts';
import { addFromSearch, firstReport, openActivity, section, signIn } from './flow-helpers.ts';
import { configure, MIB, SERIES_PACK, startStack } from './stack.ts';

test.use({ actionTimeout: 15_000 });

test('series: add, season pack, crash, import', async ({ page }, info) => {
  test.setTimeout(180_000);
  const stack = await startStack();
  try {
    await stack.createOwner();
    await configure(stack);
    const completed = { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'Show.Name.S01E03.mkv': 'three' };
    const manifest = Object.keys(completed);
    const hash = hashOf(SERIES_PACK, manifest);
    stack.tracker.state.items = [{ title: SERIES_PACK, size: 3 * 60 * 45 * MIB, files: manifest }];

    await signIn(page);
    await addFromSearch(page, 'Show Name', 'Show Name (2020)');

    await openActivity(page);
    const groupRow = page.locator('[data-row="group:tv:1:1"]');
    const inspect = page.getByRole('button', { name: 'Inspect Show Name (2020) Season 1' });
    await expect(groupRow).toContainText('Downloading');
    await inspect.click();
    await expect(page.getByRole('button', { name: 'Actions for Show Name (2020) Season 1' })).toBeVisible();
    await page.getByRole('link', { name: 'Show Name (2020) Season 1', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Show Name (2020)' })).toBeVisible();
    await openActivity(page);

    const expectOnePack = () => {
      expect(stack.tracker.state.downloads).toEqual([SERIES_PACK]);
      expect(stack.addRequests()).toHaveLength(1);
      expect([...stack.qbit.torrents.keys()]).toEqual([hash]);
    };
    expectOnePack();

    stack.qbit.progress(hash, 0.4);
    await firstReport(page, 1);
    await page.reload();
    await inspect.click();
    await expect(page.locator('[data-row="season:tv:1|1"]')).toBeVisible();
    await expect(groupRow).toContainText('Downloading');
    await expect(page.getByRole('progressbar', { name: 'Show Name (2020) Season 1 Download' })).toHaveAttribute('aria-valuenow', '40');
    await expect(page.getByRole('main').getByText('40%', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('0 / 3 episodes')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
    await expect(page.getByRole('table', { name: 'Episodes of season 1' })).toBeVisible();

    await stack.restart('SIGKILL');
    await expect(groupRow).toContainText('Downloading');
    expectOnePack();

    stack.complete(SERIES_PACK, completed, hash);
    const imported = [1, 2, 3].map((number) => join(stack.folders.tv, 'Show Name (2020)', 'Season 01', `Show Name - S01E0${number} - Episode ${number}.mkv`));
    await expect.poll(() => imported.every((file) => existsSync(file)), { timeout: 75_000 }).toBe(true);
    await expect(groupRow).toHaveCount(0, { timeout: 75_000 });
    expect(imported.map((file) => readFileSync(file, 'utf8'))).toEqual(Object.values(completed));
    expectOnePack();

    await section(page, 'Catalog');
    await page.getByRole('link', { name: /^Show Name Series\b/ }).click();
    await expect(page.getByRole('heading', { name: 'Show Name (2020)' })).toBeVisible();
    await expect(page.getByText('8.1', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'TMDB', exact: true })).toHaveAttribute('href', 'https://www.themoviedb.org/tv/1');
    await expect(page.getByRole('link', { name: 'IMDb' })).toHaveAttribute('href', 'https://www.imdb.com/title/tt0000001/');
    await expect(page.getByText('3 of 3 episodes available')).toHaveCount(0);

    await page.getByRole('region', { name: 'Season 1' }).click();
    await expect(page.getByRole('button', { name: 'Hide episodes of Season 1' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Season 1' })).toContainText('Episode 1');
  } catch (error) {
    await info.attach('server-log', { body: stack.logs(), contentType: 'text/plain' });
    throw error;
  } finally {
    await stack.stop();
  }
});
