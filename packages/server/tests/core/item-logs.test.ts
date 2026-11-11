import type { LogEntry } from '@ladarr/shared/types';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { open, type Db } from '../../src/core/db.ts';
import { createEvents } from '../../src/core/events.ts';
import { catalog, closeLog, configureItemLogs, deleteItemLog, log, logToFile, recentLogs } from '../../src/core/log.ts';
import { createQueue, type QueueEntry } from '../../src/library/downloads/queue.ts';
import { dropTitle } from '../../src/library/tools/remove.ts';

const dir = mkdtempSync(join(tmpdir(), 'ladarr-item-logs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => closeLog());

let cases = 0;
// A folder of its own for each test, so the files of one test do not count in the next.
const folder = () => join(dir, `case-${++cases}`);

// The name of the per-item file: every run of characters outside [A-Za-z0-9] becomes one underscore.
const itemPath = (file: string, id: string) => join(dirname(file), 'items', `${id.replace(/[^A-Za-z0-9]+/g, '_')}.log`);

const itemEntries = (file: string, id: string): LogEntry[] =>
  readFileSync(itemPath(file, id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);

// A catalog log follows one target of a title.
const fields = (itemId: string, itemType: string, titleKey: string, title: string, target: string) => ({ itemId, itemType, titleKey, title, target });

function entry(id: string, stage: QueueEntry['stage'] = 'queued'): QueueEntry {
  return {
    id,
    titleKey: id,
    season: null,
    number: null,
    stage,
    branch: null,
    reason: null,
    revision: 1,
    createdAt: 0,
    stageSince: 0,
    completedAt: null,
    clearedAt: null,
    priority: null,
    attempt: 1,
    attempts: [],
    history: [],
    search: null,
    release: null,
    transferHash: null,
    clientId: null,
    manualMatch: null,
    importResult: null,
  };
}

async function dbWith(...ids: string[]): Promise<Db> {
  const db = await open('unused.json');
  for (const id of ids) db.data.queue[id] = entry(id);
  return db;
}

describe('item logs', () => {
  it('writes a catalog entry of an item in the queue to its own file and to the app log', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await dbWith('tv:1:1x2');
    logToFile(file);
    configureItemLogs();

    const item = { ...fields('tv:1:1x2', 'tv', 'tv:1', 'Show', 'S01E02'), episode: 'Pilot' };
    catalog.info('search.started', 'Search started', item);

    await closeLog();
    expect(readdirSync(join(dirname(file), 'items'))).toEqual(['tv_1.log', 'tv_1_1x2.log']);
    const own = itemEntries(file, 'tv:1:1x2');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ type: 'catalog', event: 'search.started', itemId: 'tv:1:1x2', itemType: 'tv', title: 'Show', target: 'S01E02' });
    // The line of the item file is the same line as the line of the app log.
    expect(own[0]).toEqual((await recentLogs(10))[0]);
    // The file of the title holds the same line, so the page of the series shows it.
    expect(itemEntries(file, 'tv:1')).toEqual(own);
  });

  it('keeps the first entry of an item after the app log rotates, and ignores the limit', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await dbWith('movie:1');
    logToFile(file, 500);
    configureItemLogs();

    const movie = fields('movie:1', 'movie', 'movie:1', 'Movie', 'Movie');
    catalog.info('search.started', 'Search started', movie);
    catalog.info('search.finished', 'Search finished', movie);
    catalog.info('import.started', 'Import started', movie);
    // Enough entries to rotate the app log more than once, so the first one leaves the file and its backup.
    for (let i = 0; i < 300; i++) log.info('filler', { i });

    await closeLog();
    expect(readdirSync(dirname(file))).toContain('ladarr.log.1');
    expect((await recentLogs(1_000)).some((line) => line.event === 'search.started')).toBe(false);

    // The file of the item keeps every entry, and the limit does not apply while it exists.
    expect((await recentLogs(1, { itemId: 'movie:1' })).map((line) => line.message)).toEqual(['Search started', 'Search finished', 'Import started']);
    // The other filters still apply.
    expect(await recentLogs(1, { itemId: 'movie:1', type: 'system' })).toEqual([]);
    expect(await recentLogs(1, { itemId: 'movie:1', itemType: 'tv' })).toEqual([]);
  });

  it('writes nothing to an item file for an item that is not in the queue', async () => {
    const file = join(folder(), 'ladarr.log');
    // The queue has one target of the title, and the title itself is not in the queue.
    const db = await dbWith('tv:1:1x2');
    logToFile(file);
    configureItemLogs();

    catalog.info('title.refreshed', 'Title refreshed', fields('tv:1', 'tv', 'tv:1', 'Show', 'Series'));

    await closeLog();
    expect(existsSync(itemPath(file, 'tv:1'))).toBe(false);
    // The entry is in the app log, and a reader of the title falls back to it.
    expect((await recentLogs(10, { itemId: 'tv:1' })).map((line) => line.message)).toEqual(['Title refreshed']);
  });

  it('writes nothing to an item file for a system log that names an item in the queue', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await dbWith('movie:1');
    logToFile(file);
    configureItemLogs();

    log.info('Server started', { itemId: 'movie:1', itemType: 'movie' });

    await closeLog();
    expect(existsSync(itemPath(file, 'movie:1'))).toBe(false);
    expect((await recentLogs(10, { itemId: 'movie:1' })).map((line) => line.message)).toEqual(['Server started']);
  });

  it('deletes the file of an item and falls back to the app log', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await dbWith('movie:1');
    logToFile(file);
    configureItemLogs();

    const movie = fields('movie:1', 'movie', 'movie:1', 'Movie', 'Movie');
    catalog.info('search.started', 'Search started', movie);
    catalog.info('search.finished', 'Search finished', movie);
    await closeLog();
    expect(existsSync(itemPath(file, 'movie:1'))).toBe(true);

    deleteItemLog('movie:1');
    expect(existsSync(itemPath(file, 'movie:1'))).toBe(false);
    // The app log answers again, and the limit applies again.
    expect((await recentLogs(1, { itemId: 'movie:1' })).map((line) => line.message)).toEqual(['Search finished']);
    // A second delete of a file that is gone does not throw.
    expect(() => deleteItemLog('movie:1')).not.toThrow();
    expect(() => deleteItemLog('movie:99')).not.toThrow();
  });

  it('writes no item file when keepQueueLogs is off, and removes the folder of a previous run', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await dbWith('movie:1');
    const movie = fields('movie:1', 'movie', 'movie:1', 'Movie', 'Movie');

    // A run with the setting on leaves a folder that holds a file.
    logToFile(file);
    configureItemLogs();
    catalog.info('search.started', 'First', movie);
    await closeLog();
    expect(existsSync(join(dirname(file), 'items'))).toBe(true);

    db.data.settings.keepQueueLogs = false;
    logToFile(file);
    configureItemLogs();
    expect(existsSync(join(dirname(file), 'items'))).toBe(false);

    catalog.info('search.finished', 'Second', movie);
    await closeLog();
    expect(existsSync(join(dirname(file), 'items'))).toBe(false);
    // The app log still gets the entries.
    expect((await recentLogs(10)).map((line) => line.message)).toEqual(['First', 'Second']);
  });

  it('joins the lines of the targets of a title in the log of the title', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await dbWith('tv:1:1x1', 'tv:1:1x2');
    db.data.titles['tv:1'] = { key: 'tv:1', mediaType: 'tv', addedAt: 0 } as never;
    for (const id of ['tv:1:1x1', 'tv:1:1x2']) db.data.queue[id]!.titleKey = 'tv:1';
    logToFile(file);
    configureItemLogs();

    catalog.info('search', 'Series line', fields('tv:1', 'tv', 'tv:1', 'Show', 'Series'));
    catalog.info('search', 'First episode line', fields('tv:1:1x1', 'tv', 'tv:1', 'Show', 'S01E01'));
    catalog.info('search', 'Second episode line', fields('tv:1:1x2', 'tv', 'tv:1', 'Show', 'S01E02'));

    await closeLog();
    // The title has no entry in the queue, so its own line also stays in the app log. Its file joins the lines of the
    // title and of its targets.
    expect(existsSync(itemPath(file, 'tv:1'))).toBe(true);
    // A restart keeps the file of the title while its targets are in the queue.
    configureItemLogs();
    expect(existsSync(itemPath(file, 'tv:1'))).toBe(true);
    expect((await recentLogs(10, { itemId: 'tv:1', itemType: 'tv' })).map((line) => line.message)).toEqual(['Series line', 'First episode line', 'Second episode line']);
    // The log of one target keeps only the lines of that target.
    expect((await recentLogs(10, { itemId: 'tv:1:1x1', itemType: 'tv' })).map((line) => line.message)).toEqual(['First episode line']);
  });

  it('writes the cause of a status change', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await dbWith('movie:1');
    logToFile(file);
    configureItemLogs();
    const queue = createQueue(createEvents(), () => {});

    queue.move(db.data.queue['movie:1']!, { stage: 'searching' }, 'search started');

    await closeLog();
    expect((await recentLogs(10, { itemId: 'movie:1' })).map((line) => line.message)).toContain('Search started');
  });

  it('removes the item log when the target is available and keeps it when the target is cancelled', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await dbWith('movie:1', 'movie:2');
    logToFile(file);
    configureItemLogs();
    const queue = createQueue(createEvents(), () => {});

    catalog.info('search.started', 'Search started', fields('movie:1', 'movie', 'movie:1', 'Movie', 'Movie'));
    catalog.info('search.started', 'Search started', fields('movie:2', 'movie', 'movie:2', 'Other movie', 'Movie'));

    queue.move(db.data.queue['movie:1']!, { stage: 'available' }, 'imported');
    queue.move(db.data.queue['movie:2']!, { branch: 'cancelled' }, 'cancelled by the user');

    await closeLog();
    expect(existsSync(itemPath(file, 'movie:1'))).toBe(false);
    expect(existsSync(itemPath(file, 'movie:2'))).toBe(true);
    expect((await recentLogs(10, { itemId: 'movie:2' })).map((line) => line.message)).toContain('Search started');
  });

  it('removes the logs of the targets of a title that leaves the library', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await open('unused.json');
    logToFile(file);
    configureItemLogs();
    const queue = createQueue(createEvents(), () => {});

    queue.ensure('tv:1', 1, 1);
    queue.ensure('tv:1', 1, 2);
    queue.ensure('movie:2', null, null);
    await closeLog();
    expect(existsSync(itemPath(file, 'tv:1:1x1'))).toBe(true);
    expect(existsSync(itemPath(file, 'tv:1:1x2'))).toBe(true);
    expect(existsSync(itemPath(file, 'movie:2'))).toBe(true);

    dropTitle('tv:1', queue);
    expect(existsSync(itemPath(file, 'tv:1:1x1'))).toBe(false);
    expect(existsSync(itemPath(file, 'tv:1:1x2'))).toBe(false);
    // The logs of another title stay.
    expect(existsSync(itemPath(file, 'movie:2'))).toBe(true);
  });

  it('removes the files that a past run left for targets that are not in the queue', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await dbWith('movie:1', 'movie:2');
    logToFile(file);
    configureItemLogs();

    catalog.info('search.started', 'Search started', fields('movie:1', 'movie', 'movie:1', 'Movie', 'Movie'));
    catalog.info('search.started', 'Search started', fields('movie:2', 'movie', 'movie:2', 'Other movie', 'Movie'));
    await closeLog();
    expect(existsSync(itemPath(file, 'movie:2'))).toBe(true);

    // A restart reads the queue again, and the second target is not in it.
    delete db.data.queue['movie:2'];
    logToFile(file);
    configureItemLogs();

    expect(existsSync(itemPath(file, 'movie:1'))).toBe(true);
    expect(existsSync(itemPath(file, 'movie:2'))).toBe(false);
  });

  it('shows only the entries of the current record of an item', async () => {
    const file = join(folder(), 'ladarr.log');
    const db = await open('unused.json');
    const queue = createQueue(createEvents(), () => {});
    queue.ensure('movie:1', null, null);
    logToFile(file);
    configureItemLogs();

    // A line that a record with the same ID left before the current one began.
    const old = { time: '2020-01-01T00:00:00.000Z', level: 'info', type: 'catalog', event: 'search', itemId: 'movie:1', itemType: 'movie', titleKey: 'movie:1', title: 'Movie', target: 'Movie', message: 'Old run' };
    catalog.info('search.started', 'New run', fields('movie:1', 'movie', 'movie:1', 'Movie', 'Movie'));
    appendFileSync(itemPath(file, 'movie:1'), `${JSON.stringify(old)}\n`);

    await closeLog();
    expect((await recentLogs(10, { itemId: 'movie:1' })).map((line) => line.message)).toEqual(['New run']);
  });
});
