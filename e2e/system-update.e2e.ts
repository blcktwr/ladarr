import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { configure, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

const UPDATE = { available: true, latest: '9.9.9', url: 'https://example.com', notes: 'Fixed the queue.' };
const FAILURE = 'The request did not complete.';
const INSTALLED = /Version 9\.9\.9 installed, the server will restart in \ds\.\.\./;

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
});
test.afterAll(() => stack.stop());
test.beforeEach(({ context }) => context.addCookies([{ ...cookie, url: URL_BASE }]));

const checkButton = (page: Page) => page.getByRole('button', { name: 'Check updates', exact: true });
const updateDialog = (page: Page) => page.getByRole('dialog', { name: 'New version 9.9.9', exact: true });
// An open dialog hides the page from role queries, so the section is found with includeHidden.
const systemSection = (page: Page) => page.getByRole('region', { name: 'System', exact: true, includeHidden: true });

// The update is checked and installed without a real server. install gives the status of each POST.
async function checkUpdates(page: Page, { check = UPDATE, checkStatus = 200, install = async () => 202 } = {}) {
  await page.route('**/api/system/update', async (route) => {
    const post = route.request().method() === 'POST';
    const status = post ? await install() : checkStatus;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(post ? { version: '9.9.9' } : check) });
  });
  await page.goto(`${URL_BASE}/settings`);
  await checkButton(page).click();
}

async function expectNoUpdateInSection(page: Page) {
  const system = systemSection(page);
  for (const text of ['New version 9.9.9', UPDATE.notes, 'Install update', INSTALLED, FAILURE]) await expect(system.getByText(text)).toHaveCount(0);
  await expect(system.getByRole('status', { name: 'Installing update', includeHidden: true })).toHaveCount(0);
}

// A dialog that starts to close loses data-open at once, but it stays visible until its transition ends.
async function expectStaysOpen(page: Page, dialog: Locator) {
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveAttribute('data-open', '');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveAttribute('data-open', '');
}

test('shows an available update in a dialog, not in the System section', async ({ page }) => {
  await checkUpdates(page);
  const dialog = updateDialog(page);
  await expect(dialog.getByText(UPDATE.notes)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Install update', exact: true })).toBeVisible();

  const { version } = (await stack.call('GET', '/system/version')).body;
  await expect(systemSection(page).getByText(version, { exact: true })).toBeVisible();
  await expectNoUpdateInSection(page);
});

test('keeps a very long line of the release notes reachable in the dialog', async ({ page }) => {
  const line = 'x'.repeat(600);
  await checkUpdates(page, { check: { ...UPDATE, notes: line } });
  const notes = updateDialog(page).getByText(line);
  await expect(notes).toBeVisible();

  // The end of the line must show after a person scrolls to it, or because the line wraps. A clipped end does not.
  await expect
    .poll(() =>
      notes.evaluate((node) => {
        for (let box: Element | null = node; box; box = box.parentElement) {
          const { overflowX, overflowY } = getComputedStyle(box);
          if (/auto|scroll/.test(overflowX)) box.scrollLeft = box.scrollWidth;
          if (/auto|scroll/.test(overflowY)) box.scrollTop = box.scrollHeight;
        }
        const text = node.lastChild!;
        const range = document.createRange();
        range.setStart(text, text.textContent!.length - 1);
        range.setEnd(text, text.textContent!.length);
        const end = range.getBoundingClientRect();
        return node.contains(document.elementFromPoint(end.x + end.width / 2, end.y + end.height / 2));
      }),
    )
    .toBe(true);
});

test('closes the dialog before an install and opens it again', async ({ page }) => {
  await checkUpdates(page);
  const dialog = updateDialog(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await checkButton(page).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();

  await checkButton(page).click();
  await expect(dialog).toBeVisible();
});

test('keeps the dialog open through an install, counts down six seconds, then reloads the page', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await checkUpdates(page, { install: () => held.then(() => 202) });
  const dialog = updateDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Install update', exact: true }).click();

  await expect(dialog.getByRole('status', { name: 'Installing update' })).toBeVisible();
  await expectNoUpdateInSection(page);
  await expectStaysOpen(page, dialog);

  release();
  await expect(dialog.getByText(INSTALLED)).toBeVisible();
  const reloaded = page.waitForEvent('load', { timeout: 15_000 });
  await expectStaysOpen(page, dialog);
  await expectNoUpdateInSection(page);

  await reloaded;
  await expect(checkButton(page)).toBeVisible();
  await expect(page.getByText(/restart in/)).toHaveCount(0);
});

test('shows a failed install in the dialog and installs on the next try', async ({ page }) => {
  const statuses = [500, 202];
  await checkUpdates(page, { install: async () => statuses.shift()! });
  const dialog = updateDialog(page);
  const install = dialog.getByRole('button', { name: 'Install update', exact: true });
  await expect(dialog).toBeVisible();
  await install.click();
  await expect(dialog.getByText(FAILURE)).toBeVisible();
  await expect(install).toBeEnabled();
  await expectNoUpdateInSection(page);

  await install.click();
  await expect(dialog.getByText(INSTALLED)).toBeVisible();
  await expect(dialog.getByText(FAILURE)).toHaveCount(0);
});

test('leaves no failure alert after the dialog of a failed install closes', async ({ page }) => {
  await checkUpdates(page, { install: async () => 500 });
  const dialog = updateDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Install update', exact: true }).click();
  await expect(dialog.getByText(FAILURE)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(FAILURE)).toHaveCount(0);
});

test('opens no dialog when there is no update', async ({ page }) => {
  await checkUpdates(page, { check: { ...UPDATE, available: false } });
  await expect(systemSection(page).getByText('You have the latest version.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('opens no dialog when the check fails', async ({ page }) => {
  await checkUpdates(page, { checkStatus: 500 });
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(FAILURE)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
