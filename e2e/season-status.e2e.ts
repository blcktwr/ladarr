import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
});
test.afterAll(() => stack.stop());

test('the page of a series marks only the seasons that the user selected', async ({ page, context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/catalog/tv/3`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add new series' });
  await dialog.getByRole('checkbox', { name: 'Season 1' }).click();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Two Seasons (2021)' })).toBeVisible();

  // The selected season has no +, and the season that the user did not select keeps its +.
  await expect(page.getByRole('button', { name: 'Add Season 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Season 1' })).toHaveCount(0);

  // The episodes of the season that the user did not select have no status.
  await page.getByRole('button', { name: 'Show episodes of Season 2' }).click();
  const season = page.getByRole('region', { name: 'Season 2' });
  await expect(season.getByRole('table', { name: 'Episodes' })).toContainText('Season two episode 1');
  await expect(season.getByRole('table', { name: 'Episodes' })).toContainText('N/A');
  await expect(season.getByRole('table', { name: 'Episodes' })).not.toContainText('Searching');

  // The # column shows the position of the episode in the season, then the real number.
  await expect(season.getByRole('table', { name: 'Episodes' }).getByRole('cell', { name: '1 (3)', exact: true })).toBeVisible();
  await expect(season.getByRole('table', { name: 'Episodes' }).getByRole('cell', { name: '2 (4)', exact: true })).toBeVisible();

  // The Air date column shows the date as dd/MM/YYYY.
  await expect(season.getByRole('table', { name: 'Episodes' }).getByRole('cell', { name: '01/02/2021', exact: true })).toBeVisible();

  // The + selects the season, so it goes away.
  await page.getByRole('button', { name: 'Add Season 2' }).click();
  await expect(page.getByRole('button', { name: 'Add Season 2' })).toHaveCount(0);

  // A selected season has a trash instead. It asks about the files before it removes the season.
  await expect(page.getByRole('button', { name: 'Remove Season 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Season 1' }).click();
  const remove = page.getByRole('alertdialog', { name: 'Remove Season 1?' });
  await expect(remove.getByRole('switch', { name: 'Delete the files too' })).toBeVisible();
  await remove.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add Season 1' })).toBeVisible();
});
