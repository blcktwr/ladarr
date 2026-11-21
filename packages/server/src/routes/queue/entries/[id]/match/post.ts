import { db } from '../../../../../core/db.ts';
import { randomUUID } from 'node:crypto';
import type { EpisodeRef, QueueMatchPreview } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { withTitleLock } from '../../../../../core/title-lock.ts';
import { correctionJournal, correctionOf, prepareCorrection, recoverCorrection } from '../../../../../library/mapping.ts';
import { PlanError } from '../../../../../library/imports/plan.ts';
import { bindJournal } from '../../../../../library/imports/importer.ts';
import { recordTorrent } from '../../../../../library/downloads/attach.ts';
import { normalizeNumbering } from '../../../../../library/numbering.ts';
import { HASH, matchSource, torrentInUse } from '../../../../../helpers/queue-attach.ts';
import { associationState, catalogTargets, label, resolutionCurrent, resolutionVersion, shown } from '../../../../../helpers/queue.ts';
import type { Clients, EnqueueInput, Finder, ImportJournal, Job, Queue, QueueEntry } from '../../../../../types.ts';

export function queueEntryMatchPost(queue: Queue, _finder: Finder, clients: Clients, enqueue: (input: EnqueueInput) => Job): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const { file, covers, ids, preview, version, hash, source: requestedSource } = (req.body ?? {}) as { file?: unknown; covers?: unknown; ids?: unknown; preview?: boolean; version?: unknown; hash?: unknown; source?: unknown };
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    if (typeof file !== 'string' || (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => typeof id === 'string')))) return void res.status(400).json({ error: 'invalid_request' });
    const title = db.data.titles[entry.titleKey]!;
    const selectedSource = requestedSource ?? (entry.transferHash ? 'download' : 'library');
    if (selectedSource !== 'library' && selectedSource !== 'download') return void res.status(400).json({ error: 'invalid_request' });
    if (hash !== undefined && (typeof hash !== 'string' || !HASH.test(hash) || selectedSource !== 'download' || entry.season === null)) return void res.status(400).json({ error: 'invalid_request' });
    let coverage: EpisodeRef[] = entry.season === null ? [] : [{ season: entry.season, number: entry.number! }];
    if (covers !== undefined) {
      if (!Array.isArray(covers) || covers.length > 1000 || !covers.every((item) => Number.isInteger(item?.season) && Number.isInteger(item?.number))) return void res.status(400).json({ error: 'invalid_request' });
      coverage = covers.map(({ season, number }: EpisodeRef) => ({ season, number }));
      if (new Set(coverage.map((point) => `${point.season}:${point.number}`)).size !== coverage.length) return void res.status(400).json({ error: 'invalid_request' });
      if (coverage.some((point) => !title.episodes.some((episode) => episode.season === point.season && episode.number === point.number))) return void res.status(400).json({ error: 'cover_not_in_download' });
    }
    const selected: QueueEntry[] = [];
    for (const id of (ids ?? [entry.id]) as string[]) {
      const target = db.data.queue[id];
      if (!target || !shown(target) || target.state.kind === 'cancelled' || target.state.kind === 'paused' || target.titleKey !== entry.titleKey) return void res.status(400).json({ error: 'invalid_request' });
      if (hash !== undefined ? target.season === null : selectedSource === 'download' && (target.transferHash !== entry.transferHash || target.clientId !== entry.clientId)) return void res.status(400).json({ error: 'invalid_request' });
      if (!selected.includes(target)) selected.push(target);
    }
    if (hash !== undefined && !selected.includes(entry)) return void res.status(400).json({ error: 'invalid_request' });
    if (selected.some((target) => target.season !== null && !coverage.some((point) => point.season === target.season && point.number === target.number))) return void res.status(400).json({ error: 'invalid_request' });
    try {
      const source = await matchSource(entry, clients, selectedSource, hash);
      if ('error' in source) return void res.status(409).json({ error: source.error });
      const download = source.download;
      const transfer = download?.torrent.hash;
      const clientId = download?.handle.id;
      if (db.data.queue[entry.id] !== entry || selected.some((target) => db.data.queue[target.id] !== target)) return void res.status(409).json({ error: 'preview_changed' });
      const chosen = source.files.find((item) => item.rel === file);
      if (!chosen) return void res.status(400).json({ error: selectedSource === 'download' ? 'file_not_in_download' : 'file_not_in_title' });
      if (selectedSource === 'library' && (chosen.mtimeMs === null || chosen.ino === null || chosen.dev === null || !db.data.roots[title.rootId])) return void res.status(409).json({ error: 'preview_changed' });
      if (!preview && (typeof version !== 'string' || !version)) return void res.status(409).json({ error: 'preview_required' });
      const catalog = catalogTargets(title);
      const covered = entry.season === null ? [{ id: entry.id, label: label(entry), season: null, number: null }] : catalog.filter((target) => coverage.some((point) => point.season === target.season && point.number === target.number));
      const sourceEntries = Object.values(db.data.queue).filter((target) => target.titleKey === title.key).sort((a, b) => a.id.localeCompare(b.id));
      const sameSource = sourceEntries.filter((target) => !download || (target.transferHash === transfer && target.clientId === clientId));
      const taken = sameSource.filter((target) => target.manualMatch?.file === file && target.manualMatch.covers.length > 0 && !covered.some((target_) => target_.id === target.id));
      const records = Object.values(db.data.files).filter((record) => record.titleKey === title.key && (download ? record.download?.hash === transfer && record.download?.clientId === clientId && record.association?.originalName === file : record.path === file));
      const lostAvailability = title.episodes.filter((episode) => records.some((record) => record.id === episode.fileId) && !coverage.some((point) => point.season === episode.season && point.number === episode.number) && !Object.values(db.data.files).some((other) => other.titleKey === title.key && !other.missing && !records.includes(other) && other.episodes.some((point) => point.season === episode.season && point.number === episode.number))).map(({ season, number }) => ({ season, number }));
      const conflicts = sameSource.filter((target) => !selected.includes(target) && target.manualMatch && target.manualMatch.file !== file && target.manualMatch.covers.some((point) => coverage.some((cover) => cover.season === point.season && cover.number === point.number))).map((target) => ({ file: target.manualMatch!.file, ids: [target.id], code: 'shared_episode' }));
      const continued = conflicts.length ? [] : selected.map((target) => ({ id: target.id, phase: 'importing' as const }));
      const staysBlocked = sourceEntries.filter((target) => target.state.kind === 'blocked' && !continued.some((item) => item.id === target.id)).map((target) => ({ id: target.id, code: target.state.kind === 'blocked' ? target.state.problem.code : 'file_unmapped' }));
      for (const point of lostAvailability) {
        const id = `${title.key}:${point.season}x${point.number}`;
        if (!staysBlocked.some((target) => target.id === id)) staysBlocked.push({ id, code: 'file_unmapped' });
      }
      const removed = [...new Map([...taken.map((target) => ({ id: target.id, label: label(target) })), ...lostAvailability.map((point) => catalog.find((target) => target.season === point.season && target.number === point.number)!)].map((target) => [target.id, { id: target.id, label: target.label }])).values()];
      const scope = { action: 'match', entry: entry.id, source: selectedSource, ...(hash === undefined ? {} : { hash }), file, coverage, ids: selected.map((target) => target.id).sort(), manifest: source.manifest };
      const state = { selected, anchor: entry, sourceEntries, associations: associationState(title.key), files: source.files };
      const summary: QueueMatchPreview = {
        file,
        source: selectedSource,
        version: resolutionVersion(scope, state),
        effects: { lostAvailability, continued, staysBlocked, conflicts },
        affected: covered.map((target) => {
          const queued = db.data.queue[target.id];
          const episode = title.episodes.find((one) => one.season === target.season && one.number === target.number);
          const record = db.data.files[(target.season === null ? title.fileId : episode?.fileId) ?? ''];
          return { id: target.id, label: target.label, current: queued?.manualMatch?.file ?? record?.path ?? null };
        }),
        replaces: removed,
        retries: continued.map(({ id }) => ({ id, label: label(db.data.queue[id]!) })),
      };
      if (selectedSource === 'library' && title.mediaType === 'tv' && records.length) {
        const correction = correctionOf(title.key, [{ path: file, episodes: coverage }], selected.map((target) => target.id));
        summary.replaces = correction.lostAvailability.map((point) => catalog.find((target) => target.season === point.season && target.number === point.number)!).map(({ id, label }) => ({ id, label }));
        summary.retries = correction.continued.map(({ id }) => ({ id, label: label(db.data.queue[id]!) }));
        summary.effects = {
          lostAvailability: correction.lostAvailability, continued: correction.continued, staysBlocked: correction.staysBlocked,
          conflicts: correction.rows.filter((row) => row.status === 'blocked').map((row) => ({ file: row.path, ids: catalog.filter((target) => row.to.some((point) => point.season === target.season && point.number === target.number)).map((target) => target.id), code: row.reason! })),
        };
        if (preview) return void res.json(summary);
        const record = Object.values(db.data.files).find((known) => known.titleKey === title.key && known.path === file)!;
        const already = JSON.stringify(record.episodes) === JSON.stringify(coverage) && record.association?.source === 'manual' && selected.every((target) => target.state.kind !== 'blocked');
        if (!resolutionCurrent(version, scope, already ? undefined : state)) return void res.status(409).json({ error: 'preview_changed' });
        if (already) return void res.json({ ...summary, done: true });
        await withTitleLock(title.key, async () => {
          const currentEntries = Object.values(db.data.queue).filter((target) => target.titleKey === title.key).sort((a, b) => a.id.localeCompare(b.id));
          if (!resolutionCurrent(version, scope, { selected, anchor: entry, sourceEntries: currentEntries, associations: associationState(title.key), files: source.files })) throw new PlanError('mapping_stale');
          const journal = correctionJournal(prepareCorrection(correction));
          db.data.imports[journal.id] = journal;
          await db.write();
          try {
            prepareCorrection(correction);
          } catch (error) {
            delete db.data.imports[journal.id];
            await db.write();
            throw error;
          }
          const revision = db.data.queueRev + 1;
          for (const target of selected) {
            target.manualMatchRevision = revision;
            queue.touch(target);
          }
          await recoverCorrection(journal, { queue });
          if (journal.steps.length) enqueue({ type: 'import.run', payload: { hash: journal.hash }, dedupeKey: `import:${journal.hash}` });
          await db.write();
        });
        return void res.json({ ...summary, done: true });
      }
      const match = { file, covers: coverage };
      const anchors = selected.length ? selected : [entry];
      const latest = Math.max(0, ...sameSource.filter((target) => target.manualMatch?.file === file).map((target) => target.manualMatchRevision ?? 0));
      const applied = anchors.every((target) => JSON.stringify(target.manualMatch) === JSON.stringify(match) && target.manualMatchRevision !== undefined && target.manualMatchRevision >= latest && (!selected.includes(target) || ['importing', 'available'].includes(target.state.kind)) && (hash === undefined || sameSource.includes(target)));
      if (hash !== undefined && (preview || !applied) && selected.some((target) => target.state.kind !== 'blocked')) return void res.status(409).json({ error: 'preview_changed' });
      if (preview) return void res.json(summary);
      if (!resolutionCurrent(version, scope, applied ? undefined : state)) return void res.status(409).json({ error: 'preview_changed' });
      if (applied) return void res.json({ ...summary, done: true });
      if (conflicts.length || (hash !== undefined && lostAvailability.length)) return void res.status(409).json({ error: 'mapping_conflict', ...summary });
      await withTitleLock(title.key, async () => {
        const currentSource = await matchSource(entry, clients, selectedSource, hash);
        const currentEntries = Object.values(db.data.queue).filter((target) => target.titleKey === title.key).sort((a, b) => a.id.localeCompare(b.id));
        if ('error' in currentSource || (hash !== undefined && torrentInUse(entry, hash)) || !resolutionCurrent(version, { ...scope, manifest: currentSource.manifest }, { selected, anchor: entry, sourceEntries: currentEntries, associations: associationState(title.key), files: currentSource.files })) throw new PlanError('mapping_stale');
        const trimmed = selectedSource === 'download' ? records.filter((record) => record.episodes.some((point) => !coverage.some((cover) => cover.season === point.season && cover.number === point.number))).map((record) => ({ ...structuredClone(record), episodes: record.episodes.filter((point) => coverage.some((cover) => cover.season === point.season && cover.number === point.number)) })) : [];
        const pointers = title.episodes.flatMap((episode) => {
          if (!trimmed.some((record) => record.id === episode.fileId) || coverage.some((point) => point.season === episode.season && point.number === episode.number)) return [];
          const alternate = Object.values(db.data.files).find((record) => record.titleKey === title.key && !record.missing && !records.includes(record) && record.episodes.some((point) => point.season === episode.season && point.number === episode.number));
          return [{ season: episode.season, number: episode.number, fileId: alternate?.id ?? null }];
        });
        const removal = trimmed.length ? correctionJournal({ titleKey: title.key, ids: [], files: trimmed, pointers, lostAvailability, continued: [], numbering: normalizeNumbering(title.numbering) }) : undefined;
        if (removal) {
          removal.hash = entry.transferHash!;
          db.data.imports[removal.id] = removal;
        }
        if (selected.length || coverage.length) {
          for (const target of taken) {
            target.manualMatch = null;
            queue.touch(target);
          }
        }
        const revision = db.data.queueRev + 1;
        for (const target of anchors) {
          if (selected.includes(target) && target.state.kind === 'blocked') queue.retryAttempt(target, 'retry');
          if (hash !== undefined && download && !sameSource.includes(target)) {
            recordTorrent(target, { ...download, kind: source.files.length > 1 ? 'pack' : 'single', external: true });
            target.search = null;
            target.importResult = null;
            target.replaceDestination = undefined;
          }
          target.manualMatch = structuredClone(match);
          target.manualMatchRevision = revision;
          queue.touch(target);
          if (selected.includes(target)) {
            if (target.state.kind === 'available') queue.invalidate(target, 'file selected by the user', file);
            if (target.state.kind !== 'available') queue.resolve(target, 'importing', 'file selected by the user', file);
          }
        }
        const entryIds = selected.filter((target) => target.state.kind !== 'available').map((target) => target.id);
        if (entryIds.length && transfer) {
          const job = enqueue({ type: 'import.run', payload: { hash: transfer, entryIds, manual: true }, dedupeKey: `import:${transfer}`, priority: entry.priority !== null });
          if (job.type === 'import.run' && job.state === 'waiting') {
            const previous = job.payload as { manual?: boolean; entryIds?: string[] };
            job.payload = { hash: transfer, entryIds: [...new Set([...(previous.manual ? previous.entryIds ?? [] : []), ...entryIds])], manual: true };
          }
        } else if (entryIds.length) {
          const root = db.data.roots[title.rootId]!;
          const identity = { sizeBytes: chosen.sizeBytes, mtimeMs: chosen.mtimeMs!, ino: chosen.ino!, dev: chosen.dev! };
          const record = records[0] ?? { id: randomUUID(), titleKey: title.key, path: file, sizeBytes: chosen.sizeBytes, mtimeMs: chosen.mtimeMs!, episodes: [], missing: true, addedAt: Date.now() };
          record.association = { source: 'manual', originalName: record.association?.originalName ?? file, numberingRevision: normalizeNumbering(title.numbering).revision, identity };
          db.data.files[record.id] = record;
          const id = randomUUID();
          const journal: ImportJournal = {
            id, hash: `mapping:${id}`, titleKey: title.key, createdAt: Date.now(), sourceBase: root.path,
            steps: [{ entryIds, source: file, dest: file, replaces: file, state: 'planned', method: null, sizeBytes: chosen.sizeBytes, episodes: coverage, validation: 'basic', association: { source: 'manual', originalName: record.association.originalName, numberingRevision: record.association.numberingRevision }, sourceIdentity: identity }],
          };
          bindJournal(journal);
          db.data.imports[id] = journal;
          enqueue({ type: 'import.run', payload: { hash: journal.hash, entryIds, manual: true }, dedupeKey: `import:${journal.hash}`, priority: entry.priority !== null });
        }
        await db.write();
        if (removal) await recoverCorrection(removal, { queue });
      });
      res.json({ ...summary, done: true });
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      if (error instanceof PlanError) return void res.status(409).json({ error: error.code === 'mapping_stale' ? 'preview_changed' : error.code });
      throw error;
    }
  };
}
