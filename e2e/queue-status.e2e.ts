import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';
import { configure, MIB, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';

test.setTimeout(120_000);

let stack: Stack;
let cookie: Awaited<ReturnType<Stack['createOwner']>>;
const DEST = 'Show Name (2020)/Season 01/Show Name - S01E01 - Episode 1.mkv';
const SINGLE = 'Show.Name.S01E03.1080p.WEB-DL-GRP';
const torrent = async (name: string) => [...stack.qbit.torrents.values()].find((item) => item.name === name);

test.beforeAll(async () => {
  stack = await startStack();
  cookie = await stack.createOwner();
  await configure(stack);
  // The pack covers two episodes. The third episode searches on its own, so its download can run while the pack
  // completes and one of its episodes stops.
  stack.tracker.state.items = [
    { title: SERIES_PACK, size: 2 * 60 * 45 * MIB, files: ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'] },
    { title: SINGLE, size: 60 * 45 * MIB },
  ];
  const added = await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  if (added.status >= 300) throw new Error(`POST /library answered ${added.status}: ${JSON.stringify(added.body)}`);
});
test.afterAll(() => stack.stop());
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ ...cookie, url: URL_BASE }]);
});

test('shows the aggregate of the season in the row and in the inspector under every tab', async ({ page }) => {
  // The pack and the single episode download together.
  await expect.poll(async () => Boolean(await torrent(SERIES_PACK)) && Boolean(await torrent(SINGLE)), { timeout: 60_000 }).toBe(true);

  // The destination of the first episode holds a file that the library does not know, so that episode stops. The
  // single episode keeps downloading.
  const dest = join(stack.folders.tv, DEST);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, 'someone else');
  // The fake client knows the pack by the hash of its two files.
  const packFiles = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'];
  const packHash = hashOf(SERIES_PACK, packFiles);
  const list = packFiles.map((rel, index) => {
    const abs = join(stack.folders.downloads, SERIES_PACK, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `episode-${index + 1}`);
    return { name: `${SERIES_PACK}/${rel}`, size: 9, progress: 1 };
  });
  stack.qbit.setFiles(packHash, list);
  stack.qbit.progress(packHash, 1);
  await expect.poll(async () => (await stack.call('GET', '/queue/entries/tv:1:1x1')).body.entry?.reason?.code, { timeout: 60_000 }).toBe('destination_exists');
  await expect.poll(async () => (await stack.call('GET', '/queue?stage=downloading')).body.total, { timeout: 60_000 }).toBe(1);

  await page.goto(`${URL_BASE}/activity`);
  const row = page.locator('[data-row="group:tv:1:1"]');
  await expect(row).toContainText('Stuck');
  // The row and the inspector show the same status. A hint with the status name is one reading of it.
  await expect(page.getByLabel('About the status Stuck')).toHaveCount(2);

  // The season appears in Downloading and in Stuck, and its status does not change with the tab.
  for (const tab of ['Downloading', 'Stuck', 'All']) {
    await page.getByRole('tab', { name: new RegExp(tab) }).click();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Stuck');
    await expect(page.getByLabel('About the status Stuck')).toHaveCount(2);
  }
});
