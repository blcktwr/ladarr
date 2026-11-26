import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE } from './stack.ts';

test('cancels a factory reset without changing data and returns to setup after confirmation', async ({ page, context }) => {
  const stack = await startStack();
  try {
    const cookie = await stack.createOwner();
    await configure(stack);
    const added = await stack.call('POST', '/library', { mediaType: 'movie', tmdbId: 2, add: 'paused' });
    expect(added.status).toBe(201);
    await context.addCookies([{ ...cookie, url: URL_BASE }]);

    const resetPosts: unknown[] = [];
    const isReset = (url: string, method: string) => method === 'POST' && new URL(url).pathname === '/api/system/reset';
    page.on('request', (request) => {
      if (isReset(request.url(), request.method())) resetPosts.push(request.postDataJSON());
    });

    await page.goto(`${URL_BASE}/settings`);
    const reset = page.getByRole('region', { name: 'System', exact: true }).getByRole('button', { name: 'Reset', exact: true });
    const dialog = page.getByRole('alertdialog', { name: 'Reset Ladarr?' });
    await reset.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(`${URL_BASE}/settings`);
    const retained = await stack.call('GET', '/library/movie:2');
    expect(retained.status).toBe(200);
    expect(retained.body.title.key).toBe('movie:2');
    expect(resetPosts).toEqual([]);

    await reset.click();
    const [response] = await Promise.all([
      page.waitForResponse((reply) => isReset(reply.url(), reply.request().method())),
      dialog.getByRole('button', { name: 'Reset', exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
    await expect(page).toHaveURL(`${URL_BASE}/setup`);
    await expect(page.getByRole('heading', { name: "Let's start" })).toBeVisible();
    expect(resetPosts).toEqual([{ confirm: true }]);
  } finally {
    await stack.stop();
  }
});
