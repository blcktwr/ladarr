import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { PlanAction, PlanSkip } from '@ladarr/shared/enums';
import type { PlanFile, PlanPreview, PlanRequest, PlanResult, PlanTitle } from '@ladarr/shared/types';
import { Router } from 'express';
import { type Db, type MediaFile, db } from '../../core/db.ts';
import type { Events } from '../../core/events.ts';
import { inside, listFiles } from '../imports/folder-files.ts';
import type { EnqueueInput, Job } from '../../core/jobs.ts';
import { filesByTitle } from './files.ts';
import { dropSeason, dropTitle, forgetFile, retireFile, sameSeen, seeFile, pruneEmpty, torrentsForRemoval, type Seen } from './remove.ts';
import { refreshJob } from '../metadata.ts';
import { log } from '../../core/log.ts';
import { isActive, type Queue } from '../downloads/queue.ts';
import type { Clients } from '../downloads/client-api.ts';
import { checkRoot } from '../roots.ts';
import type { Tmdb } from '../../metadata/tmdb.ts';

type Deps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; queue?: Queue; cancelJob?: (id: string) => void; clients?: Clients };

const KEY = /^(movie|tv):[1-9]\d*$/;
const ACTIONS: PlanAction[] = ['pause', 'resume', 'refresh', 'preset', 'remove', 'delete_files'];
const MAX_KEYS = 500;
// The preview names every file. This limit keeps the list, and the time to build it, within reason.
const MAX_FILES = 5_000;
const MAX_STAYS = 200;
const MAX_PLANS = 20;
const PLAN_TTL_MS = 15 * 60_000;
// These problems mean that ladarr cannot trust the root, or cannot write to it. Files stay where they are.
const BLOCKING = ['not_found', 'not_directory', 'not_readable', 'not_writable', 'mount_changed'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const posix = (path: string) => path.split(sep).join('/');

type Failure = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Failure => ({ status, body: { error, ...extra } });

function parse(body: unknown): PlanRequest | Failure {
  if (!isObject(body)) return fail(400, 'invalid_plan');
  const { action, keys } = body;
  if (!ACTIONS.includes(action as PlanAction)) return fail(400, 'invalid_action');
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_KEYS || !keys.every((key) => typeof key === 'string' && KEY.test(key))) return fail(400, 'invalid_keys');
  const request: PlanRequest = { action: action as PlanAction, keys: [...new Set(keys as string[])] };
  if (request.action === 'remove') {
    if (body.deleteFiles !== undefined && typeof body.deleteFiles !== 'boolean') return fail(400, 'invalid_plan');
    request.deleteFiles = body.deleteFiles === true;
    if (body.season !== undefined) {
      if (typeof body.season !== 'number' || !Number.isInteger(body.season) || body.season < 0 || request.keys.length !== 1) return fail(400, 'invalid_season');
      request.season = body.season;
    }
  } else if (body.season !== undefined) {
    return fail(400, 'invalid_season');
  }
  if (request.action === 'preset') {
    if (body.preset !== null && !(typeof body.preset === 'string' && Object.hasOwn(db.data.profiles, body.preset))) return fail(400, 'invalid_preset');
    request.preset = body.preset;
  }
  if (request.action === 'delete_files' && body.fileIds !== undefined) {
    if (request.keys.length !== 1 || !Array.isArray(body.fileIds) || body.fileIds.length > MAX_FILES || !body.fileIds.every((id) => typeof id === 'string')) return fail(400, 'invalid_files');
    request.fileIds = [...new Set(body.fileIds as string[])];
  }
  return request;
}

// What the preview saw. The apply checks that the library and the disk are still the same.
type Stored = { preview: PlanPreview; seen: Map<string, Seen>; ids: Map<string, string[]> };

export function libraryPlansRouter({ tmdb, events, enqueue, queue, cancelJob, clients }: Deps) {
  const router = Router();
  // shortcut: plans stay in memory, so a restart drops them. The user starts the preview again.
  const plans = new Map<string, Stored>();

  const destructive = (request: PlanRequest) => request.action === 'delete_files' || (request.action === 'remove' && request.deleteFiles === true);
  const journalOf = (key: string) => Object.values(db.data.imports).some((journal) => journal.titleKey === key);

  // Removes the torrents of a dropped title or season. A client that fails does not stop the removal.
  async function removeTorrents(refs: { clientId: string; hash: string }[], deleteFiles: boolean) {
    for (const ref of refs) {
      try {
        await clients?.get(ref.clientId)?.api.remove(ref.hash, deleteFiles);
      } catch (error) {
        log.warn('could not remove torrent', { clientId: ref.clientId, hash: ref.hash, error: String(error) });
      }
    }
  }

  // The real path of the root, or the reason that the files cannot be touched now.
  async function rootOf(rootId: string): Promise<{ real: string } | { skip: PlanSkip }> {
    const root = db.data.roots[rootId];
    if (!root) return { skip: 'root_unavailable' };
    const health = await checkRoot(root.path, root.dev);
    if (health.problems.some((problem) => BLOCKING.includes(problem))) return { skip: 'root_unavailable' };
    return { real: await realpath(root.path) };
  }

  async function preview(request: PlanRequest): Promise<Stored | Failure> {
    const titles = [];
    for (const key of request.keys) {
      const title = db.data.titles[key];
      if (!title) return fail(404, 'not_found', { key });
      titles.push(title);
    }
    if (request.action === 'refresh' && !tmdb) return fail(503, 'metadata_unavailable');

    const deleting = destructive(request);
    const groups = filesByTitle();
    const downloads = new Map<string, number>();
    for (const entry of Object.values(db.data.queue)) if (entry.attempt > 0 && isActive(entry)) downloads.set(entry.titleKey, (downloads.get(entry.titleKey) ?? 0) + 1);

    const out: PlanPreview = { planId: randomUUID(), request, titles: [], files: [], stays: [], staysCutOff: 0, expiresAt: Date.now() + PLAN_TTL_MS };
    const stored: Stored = { preview: out, seen: new Map(), ids: new Map() };

    for (const title of titles) {
      let records = groups.get(title.key) ?? [];
      if (request.action === 'remove' && request.season !== undefined) {
        const season = request.season;
        if (title.mediaType !== 'tv' || !title.episodes.some((episode) => episode.season === season)) return fail(400, 'invalid_season');
        records = records.filter((file) => file.episodes.length > 0 && file.episodes.every((episode) => episode.season === season));
      }
      stored.ids.set(title.key, records.map((file) => file.id));
      if (request.fileIds) {
        const wanted = new Set(request.fileIds);
        records = records.filter((file) => wanted.has(file.id));
        if (records.length !== wanted.size) return fail(400, 'invalid_files');
      }
      const row: PlanTitle = {
        key: title.key,
        title: title.meta.title,
        year: title.meta.year,
        mediaType: title.mediaType,
        files: records.length,
        bytes: records.reduce((sum, file) => sum + file.sizeBytes, 0),
        activeDownloads: downloads.get(title.key) ?? 0,
        unchanged: (request.action === 'pause' && title.paused) || (request.action === 'resume' && !title.paused) || (request.action === 'preset' && title.preset === request.preset),
        skip: null,
      };
      out.titles.push(row);
      // A title removal with an unfinished import would leave the journal without a title.
      if ((request.action === 'remove' || request.action === 'delete_files') && journalOf(title.key)) row.skip = 'import_running';
      if (!deleting || row.skip) continue;

      const root = await rootOf(title.rootId);
      if ('skip' in root) {
        row.skip = root.skip;
        continue;
      }
      for (const file of records) {
        const found = await seeFile(root.real, file.path);
        const seen = 'reason' in found ? null : found.seen;
        stored.seen.set(file.id, seen);
        out.files.push({ id: file.id, titleKey: title.key, path: file.path, sizeBytes: seen?.sizeBytes ?? file.sizeBytes, present: seen !== null, problem: 'reason' in found ? found.reason : null, episodes: file.episodes });
        if (out.files.length > MAX_FILES) return fail(413, 'plan_too_large');
      }
      if (request.action === 'remove' && request.season === undefined && title.folder) {
        const folder = await realpath(join(root.real, title.folder)).catch(() => undefined);
        if (folder && folder !== root.real && inside(root.real, folder)) {
          const moving = new Set(out.files.filter((file) => file.titleKey === title.key).map((file) => file.path));
          const { files } = await listFiles(folder, MAX_FILES).catch(() => ({ files: [] }));
          const rest = files.map((file) => posix(relative(root.real, join(folder, file.path)))).filter((path) => !moving.has(path));
          out.stays.push(...rest.slice(0, MAX_STAYS).map((path) => ({ titleKey: title.key, path })));
          out.staysCutOff += Math.max(0, rest.length - MAX_STAYS);
        }
      }
    }
    return stored;
  }

  // The keys of the titles that differ from the preview. The apply changes nothing when there is one.
  async function changedSince(stored: Stored): Promise<string[]> {
    const { preview: plan } = stored;
    const changed = new Set<string>();
    const groups = filesByTitle();
    for (const row of plan.titles) {
      const title = db.data.titles[row.key];
      if (!title) {
        changed.add(row.key);
        continue;
      }
      if (row.skip) continue;
      // A removal takes every file record of the title, or of the season. A new record means a new file.
      if (plan.request.action === 'remove') {
        const season = plan.request.season;
        const before = new Set(stored.ids.get(row.key));
        const current = groups.get(row.key) ?? [];
        const now = season === undefined ? current : current.filter((file) => file.episodes.length > 0 && file.episodes.every((episode) => episode.season === season));
        if (now.length !== before.size || now.some((file) => !before.has(file.id))) changed.add(row.key);
      }
      const root = await rootOf(title.rootId);
      for (const file of plan.files.filter((item) => item.titleKey === row.key)) {
        const record = db.data.files[file.id];
        if (!record || record.path !== file.path || 'skip' in root) {
          changed.add(row.key);
          continue;
        }
        const found = await seeFile(root.real, file.path);
        const same = file.problem ? 'reason' in found && found.reason === file.problem : !('reason' in found) && sameSeen(found.seen, stored.seen.get(file.id) ?? null);
        if (!same) changed.add(row.key);
      }
    }
    return [...changed];
  }

  // Deletes the files of one title. The records change only for the files that are gone.
  async function retireTitle(stored: Stored, key: string, root: { real: string }, result: PlanResult) {
    const retired: string[] = [];
    let failed = 0;
    for (const file of stored.preview.files.filter((item) => item.titleKey === key)) {
      // An import can start while the files are deleted. It replaces files, so no more deletions after it starts.
      if (journalOf(key)) {
        failed++;
        result.failed.push({ path: file.path, reason: 'import_running' });
        continue;
      }
      const outcome = await retireFile(root.real, file.path, stored.seen.get(file.id) ?? null);
      if (outcome.ok) {
        retired.push(file.id);
        if (outcome.how === 'deleted') result.deleted++;
      } else {
        failed++;
        result.failed.push({ path: file.path, reason: outcome.reason });
      }
    }
    // No await from here to the end of this function, so the records change in one step.
    const current = db.data.titles[key];
    if (current) for (const id of retired) forgetFile(current, id);
    else for (const id of retired) delete db.data.files[id];
    log.info('library files deleted', { key, deleted: retired.length, failed });
    return failed;
  }

  async function apply(stored: Stored): Promise<PlanResult> {
    const { request } = stored.preview;
    const result: PlanResult = { changed: 0, deleted: 0, skipped: [], failed: [] };
    const skip = (key: string, reason: string) => void result.skipped.push({ key, reason });
    // A removal with a season takes that season only. The title and the other seasons stay.
    const season = request.action === 'remove' ? request.season : undefined;

    for (const row of stored.preview.titles) {
      const title = db.data.titles[row.key];
      if (!title) {
        skip(row.key, 'title_gone');
        continue;
      }
      if (row.skip) {
        skip(row.key, row.skip);
        continue;
      }
      if (row.unchanged) continue;
      // An import can start between the preview and the apply.
      if ((request.action === 'remove' || request.action === 'delete_files') && journalOf(row.key)) {
        skip(row.key, 'import_running');
        continue;
      }

      let pruneRoot: string | undefined;
      let kept = false;
      let removedFiles: MediaFile[] = [];
      if (request.action === 'pause' || request.action === 'resume') title.paused = request.action === 'pause';
      else if (request.action === 'preset') title.preset = request.preset ?? null;
      else if (request.action === 'refresh') enqueue(refreshJob(row.key));
      else {
        if (destructive(request)) {
          const root = await rootOf(title.rootId);
          if ('skip' in root) {
            skip(row.key, root.skip);
            continue;
          }
          // The torrents of these files go with them. The records leave before the torrent calls.
          if (request.action === 'remove') {
            removedFiles = Object.values(db.data.files).filter(
              (file) => file.titleKey === row.key && (season === undefined || (file.episodes.length > 0 && file.episodes.every((episode) => episode.season === season))),
            );
          }
          kept = (await retireTitle(stored, row.key, root, result)) > 0;
          pruneRoot = root.real;
          // An import can start while the files are deleted. It needs its title to end, so the title stays.
          if (request.action === 'remove' && !kept && journalOf(row.key)) {
            kept = true;
            skip(row.key, 'import_running');
          }
        }
        if (season !== undefined) {
          const removed = Object.values(db.data.queue).filter((entry) => entry.titleKey === row.key && entry.season === season);
          const ids = new Set(removed.map((entry) => entry.id));
          const refs = torrentsForRemoval(removed, Object.values(db.data.queue).filter((entry) => !ids.has(entry.id)), removedFiles);
          dropSeason(row.key, season, queue, cancelJob);
          title.seasonOverrides[String(season)] = 'unmonitored';
          for (const episode of title.episodes) if (episode.season === season) episode.override = null;
          if (!kept && request.deleteFiles === true) await removeTorrents(refs, true);
        } else if (request.action === 'remove' && !kept) {
          const removed = Object.values(db.data.queue).filter((entry) => entry.titleKey === row.key);
          const ids = new Set(removed.map((entry) => entry.id));
          const refs = torrentsForRemoval(removed, Object.values(db.data.queue).filter((entry) => !ids.has(entry.id)), removedFiles);
          dropTitle(row.key, queue, cancelJob);
          if (request.deleteFiles === true) await removeTorrents(refs, true);
        }
        if (kept && !result.skipped.some((item) => item.key === row.key)) skip(row.key, 'files_not_deleted');
      }
      await db.write();
      events.publish('library.changed', { key: row.key });
      if (kept && season === undefined) continue;
      result.changed++;
      // The folder of a removed title goes when it is empty. A folder with other files stays.
      if (request.action === 'remove' && season === undefined && pruneRoot && title.folder) await pruneEmpty(pruneRoot, title.folder);
    }
    return result;
  }

  router.post('/plans', async (req, res) => {
    const request = parse(req.body);
    if ('status' in request) return void res.status(request.status).json(request.body);
    for (const [id, plan] of plans) if (plan.preview.expiresAt < Date.now()) plans.delete(id);
    const stored = await preview(request);
    if ('status' in stored) return void res.status(stored.status).json(stored.body);
    plans.set(stored.preview.planId, stored);
    while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value!);
    res.json(stored.preview);
  });

  router.post('/plans/:id/apply', async (req, res) => {
    const stored = plans.get(req.params.id);
    if (!stored || stored.preview.expiresAt < Date.now()) return void res.status(404).json({ error: 'plan_not_found' });
    // The plan is spent at once, so the same plan cannot run twice.
    plans.delete(req.params.id);
    const keys = destructive(stored.preview.request) ? await changedSince(stored) : [];
    if (keys.length) return void res.status(409).json({ error: 'plan_changed', keys });
    res.json(await apply(stored));
  });

  return router;
}
