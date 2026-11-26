import { constants } from 'node:fs';
import { access, lstat, realpath, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { db, emptyData } from '../core/db.ts';
import { closeLog, configureItemLogs, logToFile } from '../core/log.ts';
import { createQbittorrent } from '../library/downloads/qbittorrent.ts';
import { ownsUpload } from '../library/downloads/queue.ts';
import { inside, sameIdentity } from '../library/roots.ts';
import { sameSeen, seeFile, torrentsForRemoval } from '../library/tools/remove.ts';
import type { JournalStep, Root, Seen } from '../types.ts';

function ignoreMissing(error: NodeJS.ErrnoException) {
  if (error.code !== 'ENOENT') throw error;
}

async function rootPath(root: Root) {
  const info = await lstat(root.path).catch(ignoreMissing);
  if (!info) return;
  if (!info.isDirectory() || info.dev !== root.dev) throw new Error(`Cannot use library folder ${root.path}.`);
  const real = await realpath(root.path).catch(ignoreMissing);
  if (!real) return;
  if (real !== resolve(root.path) || real === parse(real).root) {
    throw new Error(`Cannot use library folder ${root.path}.`);
  }
  return real;
}

async function fileAt(root: Root, path: string) {
  if (isAbsolute(path)) throw new Error(`Cannot delete library file ${path}.`);
  const found = await seeFile(root.path, path);
  if ('reason' in found || found.abs !== resolve(root.path, path)) throw new Error(`Cannot delete library file ${path}.`);
  return found;
}

async function libraryFiles(configDir: string) {
  const roots = new Map<string, Root | null>();
  const files = new Map<string, { root: Root; path: string; seen: Seen }>();
  const config = await realpath(configDir);

  async function add(titleKey: string, path: string, identity?: JournalStep['stagedIdentity']) {
    const rootId = db.data.titles[titleKey]?.rootId;
    const saved = rootId && db.data.roots[rootId];
    if (!saved) throw new Error('The library folder does not exist.');
    let root = roots.get(saved.id);
    if (root === undefined) {
      const real = await rootPath(saved);
      if (real && (inside(real, config) || inside(config, real))) throw new Error(`Cannot use library folder ${saved.path}.`);
      root = real ? { ...saved, path: real } : null;
      roots.set(saved.id, root);
    }
    if (!root) return;
    const found = await fileAt(root, path);
    if (!found.seen || files.has(found.abs)) return;
    if (identity) {
      const info = await lstat(found.abs).catch(ignoreMissing);
      if (!info || !sameIdentity(identity, info)) return;
    }
    if (!(await access(dirname(found.abs), constants.W_OK | constants.X_OK).then(() => true, ignoreMissing))) return;
    files.set(found.abs, { root, path, seen: found.seen });
  }

  for (const file of Object.values(db.data.files)) await add(file.titleKey, file.path);
  for (const journal of Object.values(db.data.imports)) {
    for (const step of journal.steps) {
      if (journal.kind !== 'rename') {
        const stage = join(dirname(step.dest), `.ladarr-${journal.id.slice(0, 8)}-${basename(step.dest)}`);
        await add(journal.titleKey, stage, step.stagedIdentity);
      }
      if (step.stagedIdentity) await add(journal.titleKey, step.dest, step.stagedIdentity);
    }
  }
  return files.values();
}

async function removeDownloads() {
  const entries = Object.values(db.data.queue).filter((entry) =>
    ownsUpload(entry) || (entry.transferHash && !entry.release?.external && db.data.sentTorrents[entry.transferHash]),
  );
  const files = Object.values(db.data.files).filter((file) => file.download?.external === false);
  const refs = torrentsForRemoval(entries, [], files, [], db.data.queueItems);
  if (refs.some(({ hash }) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash))) throw new Error('A torrent hash is not valid.');
  for (const config of db.data.downloadClients) {
    const owned = refs.filter(({ clientId }) => clientId === config.id);
    if (!owned.length) continue;
    const client = createQbittorrent(config);
    for (const { hash } of owned) await client.remove(hash, true);
  }
}

export async function reset({ configDir, backupDir, logFile }: { configDir: string; backupDir: string; logFile: string }, save: () => Promise<void>) {
  // Check all catalog paths before the first deletion. Do not remove an entire library folder.
  const files = await libraryFiles(configDir);
  await save();
  await removeDownloads();
  for (const { root, path, seen } of files) {
    if (!(await rootPath(root))) continue;
    const current = await fileAt(root, path);
    if (!current.seen) continue;
    if (!sameSeen(current.seen, seen)) throw new Error(`Cannot delete library file ${path}. The file changed.`);
    await unlink(current.abs).catch(ignoreMissing);
  }

  await rm(backupDir, { recursive: true, force: true });
  await closeLog();
  try {
    await rm(dirname(logFile), { recursive: true, force: true });
    const previous = db.data;
    db.data = emptyData();
    try {
      await save();
    } catch (error) {
      db.data = previous;
      throw error;
    }
  } finally {
    logToFile(logFile);
    configureItemLogs();
  }
}
