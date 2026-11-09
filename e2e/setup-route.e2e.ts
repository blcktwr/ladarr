import { expect, test } from './fixtures.ts';
import { OWNER, startStack, URL_BASE } from './stack.ts';

test.setTimeout(120_000);

test('the whole first-run setup stays on /setup until it is complete', async ({ page }) => {
  const stack = await startStack();
  try {
    // The setup is not done, so a page of the app sends the user to /setup.
    await page.goto(`${URL_BASE}/catalog`);
    await page.waitForURL((url) => url.pathname === '/setup');
    await expect(page.getByRole('heading', { name: "Let's start" })).toBeVisible();

    await page.getByLabel(/^Password\b/).fill(OWNER.password);
    await page.getByLabel('Repeat password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'Where is the media?' })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/setup');

    await page.getByLabel('Movies folder').fill(stack.folders.movies);
    await page.getByLabel('Series folder').fill(stack.folders.tv);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Connect the clients' })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/setup');

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'Where is the media?' })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: "Let's start" })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore from backup' })).toBeVisible();
    await page.getByLabel(/^Password\b/).fill(OWNER.password);
    await page.getByLabel('Repeat password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('heading', { name: 'Where is the media?' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connect the clients' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Connect the clients' })).toBeVisible();

    // A reload keeps the setup at /setup.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Connect the clients' })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/setup');

    // The step needs one indexer and one client that is on, so Continue waits for both, and says why.
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveAttribute('title', 'Indexer and download client required');
    await page.getByRole('button', { name: 'Add indexer' }).click();
    const indexer = page.getByRole('dialog', { name: 'Add an indexer' });
    await indexer.getByLabel(/^Name/).fill('Tracker');
    await indexer.getByLabel('Address').fill(`http://127.0.0.1:${stack.tracker.port}/2/`);
    await indexer.getByLabel('API key').fill('indexer-key');
    await indexer.getByRole('button', { name: 'Test connection' }).click();
    await expect(indexer.getByText('Connected')).toBeVisible();
    await indexer.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(indexer).toBeHidden();
    // The indexer alone is not enough.
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveAttribute('title', 'Indexer and download client required');
    await page.getByRole('button', { name: 'Add client' }).click();
    const client = page.getByRole('dialog', { name: 'Add a download client' });
    await client.getByLabel(/^Name/).fill('qBittorrent');
    await client.getByLabel('Host').fill('127.0.0.1');
    await client.getByLabel('Port').fill(String(stack.qbit.port));
    await client.getByLabel('User name').fill('admin');
    await client.getByLabel('Password').fill('secret');
    await expect(client.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    await client.getByRole('button', { name: 'Test connection' }).click();
    await expect(client.getByText('Connected')).toBeVisible();
    await expect(client.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    await client.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(client).toBeHidden();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Continue' })).not.toHaveAttribute('title');

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('link', { name: 'Catalog', exact: true })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/catalog');

    // The setup is complete, so /setup sends the user to the catalog.
    await page.goto(`${URL_BASE}/setup`);
    await expect(page.getByRole('link', { name: 'Catalog', exact: true })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/catalog');
  } finally {
    await stack.stop();
  }
});
