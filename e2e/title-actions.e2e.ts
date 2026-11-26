import type { Page } from '@playwright/test';
import { expect, test as base } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

const test = base.extend<{ stack: Stack }>({
  stack: async ({ context }, use) => {
    const stack = await startStack();
    try {
      const cookie = await stack.createOwner();
      await context.addCookies([{ ...cookie, url: URL_BASE }]);
      await configure(stack);
      await use(stack);
    } finally {
      await stack.stop();
    }
  },
});

async function openActions(page: Page) {
  const trigger = page.getByRole('main').getByRole('button', { name: 'More actions', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Upload torrent', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Attach download', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  return menu;
}

for (const { name, mediaType, tmdbId } of [
  { name: 'movie', mediaType: 'movie', tmdbId: 900001 },
  { name: 'series', mediaType: 'tv', tmdbId: 1 },
]) {
  const url = `${URL_BASE}/catalog/${mediaType}/${tmdbId}`;

  test(`shows both download actions before adding a ${name}`, async ({ page, stack }) => {
    expect((await stack.call('GET', `/library/${mediaType}:${tmdbId}`)).status).toBe(404);
    await page.goto(url);
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    const menu = await openActions(page);
    await menu.getByRole('menuitem', { name: 'Upload torrent', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Upload torrent', exact: true })).toBeVisible();
  });

  test(`keeps both download actions visible while adding a ${name}`, async ({ page, stack }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`${URL_BASE}/api/library`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await held;
      await route.abort();
    });
    try {
      await page.goto(url);
      if (mediaType === 'tv') await expect(page.getByRole('region', { name: 'Season 1', exact: true })).toBeVisible();
      const add = page.getByRole('button', { name: 'Add', exact: true });
      const submitted = page.waitForRequest((request) => request.url() === `${URL_BASE}/api/library` && request.method() === 'POST');
      await add.click();
      await submitted;
      await expect(add).toBeDisabled();
      await openActions(page);
    } finally {
      release();
    }
  });

  test(`keeps both download actions alongside Search and Delete for a ${name} in the library`, async ({ page, stack }) => {
    const added = await stack.call('POST', '/library', { mediaType, tmdbId, add: 'paused' });
    expect(added.status).toBe(201);
    await page.goto(url);
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    await openActions(page);
  });
}
