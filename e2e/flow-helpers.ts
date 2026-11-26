import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';
import { OWNER, URL_BASE } from './stack.ts';

// The first client poll for a new download can take 10 seconds.
export async function firstReport(page: Page, transfers: number) {
  await expect.poll(async () => (await (await page.request.get(`${URL_BASE}/api/queue/summary`)).json()).activeTransfers, { timeout: 70_000, intervals: [500] }).toBe(transfers);
}

export async function signIn(page: Page) {
  await page.goto(URL_BASE);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Catalog', exact: true })).toBeVisible();
}

export const section = (page: Page, name: string) => page.getByRole('link', { name, exact: true }).click();
export const openActivity = (page: Page) => page.locator('a[href$="/activity"]').click();

export async function addFromSearch(page: Page, query: string, heading: string) {
  const box = page.getByRole('searchbox', { name: 'Search', exact: true });
  await box.fill(query);
  await box.press('Enter');
  await page.getByRole('main').getByRole('link', { name: query }).getByText(query, { exact: true }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Added to the queue')).toBeVisible();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
}
