import { db } from '../../../../../core/db.ts';
import type { AttachPreview } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { isActive } from '../../../../../library/downloads/queue.ts';
import { attachTorrent } from '../../../../../library/downloads/attach.ts';
import { inspectCoverage } from '../../../../../library/coverage.ts';
import { normalizeNumbering } from '../../../../../library/numbering.ts';
import { isSample, isVideoFile } from '../../../../../library/parse.ts';
import { attachRefusal, HASH, MAX_TARGETS } from '../../../../../helpers/queue-attach.ts';
import { associationState, label, resolutionCurrent, resolutionVersion, shown } from '../../../../../helpers/queue.ts';
import type { ClientHandle, Clients, Queue, Torrent } from '../../../../../types.ts';

// Attaches a torrent that is in the client already. The user confirms the owner and the title before anything changes.
export function queueEntryAttachPost(queue: Queue, clients: Clients): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const { hash: rawHash, ids, confirmOwner, confirmTitle, preview, version } = (req.body ?? {}) as { hash?: unknown; ids?: unknown; confirmOwner?: unknown; confirmTitle?: unknown; preview?: unknown; version?: unknown };
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    const hash = typeof rawHash === 'string' ? rawHash.toLowerCase() : '';
    if (!HASH.test(hash) || (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_TARGETS || !ids.every((id) => typeof id === 'string')))) return void res.status(400).json({ error: 'invalid_request' });
    if (!preview && (confirmOwner !== true || confirmTitle !== true)) return void res.status(400).json({ error: 'confirmation_required' });

    const targets = [entry];
    for (const id of (ids ?? []) as string[]) {
      const other = db.data.queue[id];
      if (!other || !shown(other) || other.titleKey !== entry.titleKey) return void res.status(400).json({ error: 'invalid_request' });
      if (!targets.includes(other)) targets.push(other);
    }
    const refused = () =>
      targets.flatMap((target) => {
        const reason = attachRefusal(target);
        return reason ? [{ id: target.id, reason }] : [];
      });
    const unsupported = refused();
    const sameDownload = targets.every((target) => target.transferHash === hash && ['downloading', 'importing', 'available'].includes(target.state.kind));
    const replay = version !== undefined && unsupported.every(({ id }) => {
      const target = db.data.queue[id]!;
      return target.transferHash === hash && ['downloading', 'importing', 'available'].includes(target.state.kind);
    });
    if (unsupported.length && !sameDownload && !replay) return void res.status(409).json({ error: 'attach_not_supported', unsupported });

    const handles = clients.all();
    if (!handles.length) return void res.status(409).json({ error: 'client_missing' });
    let torrent: Torrent | undefined;
    let owner: ClientHandle | undefined;
    let files: { name: string; sizeBytes: number }[] = [];
    try {
      for (const handle of handles) {
        torrent = (await handle.api.byHashes([hash]))[0];
        if (torrent) {
          owner = handle;
          break;
        }
      }
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
    if (!torrent || !owner) return void res.status(404).json({ error: 'torrent_not_found' });
    try {
      files = (await owner.api.files(hash)).map(({ name, sizeBytes }) => ({ name, sizeBytes })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
    if (targets.some((target) => db.data.queue[target.id] !== target)) return void res.status(409).json({ error: 'preview_changed' });
    // The client took time to answer. A target can have changed in that time, so the targets are checked again, and no wait follows.
    const changed = refused();
    if (changed.length && !sameDownload && !replay) return void res.status(409).json({ error: 'attach_not_supported', unsupported: changed });
    if (Object.values(db.data.queue).some((other) => other.transferHash === hash && isActive(other) && other.titleKey !== entry.titleKey)) return void res.status(409).json({ error: 'torrent_in_use' });

    const title = db.data.titles[entry.titleKey]!;
    const videos = files.filter((file) => isVideoFile(file.name) && !isSample(file.name));
    const coverage = targets.map((target) => {
      const status = target.season === null
        ? videos.length === 1 ? 'identified' : 'unknown'
        : inspectCoverage(files.map((file) => file.name), title, target.numbering ?? title.numbering, null).status({ season: target.season, number: target.number! });
      return { target, status };
    });
    const scope = {
      action: 'attach', hash, ids: targets.map((target) => target.id).sort(), files,
      source: { clientId: owner.id, contentPath: torrent.contentPath, savePath: torrent.savePath },
      numbering: targets.map((target) => ({ id: target.id, map: normalizeNumbering(target.numbering ?? title.numbering) })),
    };
    const state = { targets, associations: associationState(entry.titleKey) };
    const blocked = coverage.flatMap(({ target, status }) => status === 'identified' ? [] : [{ id: target.id, label: label(target), code: status === 'absent' ? 'pack_partial' : 'coverage_unknown', coverage: status }]);
    const summary: AttachPreview = {
      hash, name: torrent.name, version: resolutionVersion(scope, state),
      affected: coverage.filter(({ status }) => status === 'identified').map(({ target }) => ({ id: target.id, label: label(target) })),
      blocked,
    };
    if (preview) return void res.json(summary);
    if (typeof version !== 'string' || !version) return void res.status(409).json({ error: 'preview_required' });
    const applied = coverage.every(({ target, status }) => status === 'absent'
      ? target.state.kind === 'blocked' && target.state.problem.code === 'pack_partial' && target.transferHash !== hash
      : target.transferHash === hash && (status === 'identified' ? ['downloading', 'importing', 'available'].includes(target.state.kind) : target.state.kind === 'blocked' && target.state.problem.code === 'coverage_unknown'));
    if (!resolutionCurrent(version, scope, applied ? undefined : state)) return void res.status(409).json({ error: 'preview_changed' });
    if (applied) return void res.json({ ...summary, done: true });

    await attachTorrent({ queue }, { handle: owner, torrent, targets: coverage.filter(({ status }) => status !== 'absent').map(({ target }) => target), cause: 'download attached by the user', manual: true });
    for (const { target, status } of coverage) {
      if (status === 'absent') queue.block(target, { code: 'pack_partial', detail: torrent.name }, 'the manifest has no file for this target');
      if (status === 'unknown') queue.block(target, { code: 'coverage_unknown', detail: torrent.name }, 'the files need a manual association');
    }
    res.json({ ...summary, done: true });
  };
}
