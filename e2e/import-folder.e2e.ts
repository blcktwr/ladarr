import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: { name: string; value: string };
test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
});
test.afterAll(() => stack.stop());

test('imports a folder and links its files into the catalog', async ({ page, context }) => {
  const folder = join(stack.folders.downloads, 'Imported Show');
  mkdirSync(folder, { recursive: true });
  const source = join(folder, 'Show.Name.S01E01.1080p.WEB-DL.mkv');
  writeFileSync(source, 'episode one');

  await context.addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(`${URL_BASE}/catalog`);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add manually', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add manually' });
  await dialog.getByLabel('Folder').fill(folder);
  await dialog.getByRole('button', { name: 'Read the folder' }).click();

  // The folder name finds no title, so the name of the file gives "Show Name".
  await expect(dialog.getByText('Looking for Show Name')).toBeVisible();
  await dialog.getByRole('button', { name: 'Use this title' }).click();
  await expect(dialog.getByText('Show Name (2020)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 1 file' }).click();
  await expect(dialog.getByText('The run ended.')).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Open the title' }).click();

  await expect(page.getByRole('heading', { name: 'Show Name (2020)' })).toBeVisible();
  const library = join(stack.folders.tv, 'Show Name (2020)', 'Season 01', 'Show Name - S01E01 - Episode 1.mkv');
  expect(existsSync(library)).toBe(true);
  expect(statSync(library).ino).toBe(statSync(source).ino);
  expect(statSync(source).nlink).toBe(2);
});
