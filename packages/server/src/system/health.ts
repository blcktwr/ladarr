import type { ClientState, RootProblem } from '@ladarr/shared/enums';
import type { Problem } from '@ladarr/shared/types';
import { listBackups } from './backup.ts';
import { type Db, db } from '../core/db.ts';
import { checkRoot } from '../library/roots.ts';
import type { Tmdb } from '../metadata/tmdb.ts';

type Sources = { tmdb?: Tmdb; heartbeat?: () => number; backupDir?: string; clientCheck?: () => Promise<ClientState>; ffprobe?: () => Promise<boolean> };

const HEARTBEAT_MAX_AGE_MS = 30_000;
const BACKUP_MAX_AGE_MS = 48 * 60 * 60_000;

// The messages and the actions are keys of the web i18n.
const rootText: Record<Exclude<RootProblem, 'low_space'>, { message: string; action: string }> = {
  not_found: { message: 'The folder {path} does not exist.', action: 'Mount the disk or fix the path. The library records stay.' },
  not_directory: { message: 'The path {path} is not a folder.', action: 'Select a folder in Settings.' },
  not_readable: { message: 'Cannot read {path}.', action: 'Give the user that runs the server read access to the folder.' },
  not_writable: { message: 'Cannot write to {path}.', action: 'Give the user that runs the server write access to the folder.' },
  mount_changed: { message: 'Another disk is mounted at {path} now, or the mount is gone.', action: 'If the disk is right, accept it. If not, mount the right disk.' },
};

export async function collectProblems({ tmdb, heartbeat, backupDir, clientCheck, ffprobe }: Sources): Promise<Problem[]> {
  const problems: Problem[] = [];

  if (!tmdb) problems.push({ id: 'metadata_missing', message: 'No metadata provider is connected.', action: 'Build the image with a TMDB key.' });
  else {
    const { code } = tmdb.status();
    if (code === 'invalid_key') problems.push({ id: 'metadata_rejected', message: 'TMDB rejects the API key.', action: 'Build the image with a valid TMDB key.' });
    else if (code) problems.push({ id: 'metadata_unavailable', message: 'TMDB does not answer.', action: 'Saved data stays visible until TMDB answers.' });
  }

  if (heartbeat && Date.now() - heartbeat() >= HEARTBEAT_MAX_AGE_MS) {
    problems.push({ id: 'worker_stalled', message: 'The worker does not run.', action: 'Start the server again.' });
  }

  // A missing folder is a problem to show. It never removes a record from the library.
  await Promise.all(
    Object.values(db.data.roots).map(async (root) => {
      const { problems: found, freeBytes } = await checkRoot(root.path, root.dev);
      for (const problem of found) {
        if (problem === 'low_space') {
          const free = freeBytes === null ? null : `${(freeBytes / 1024 ** 3).toFixed(1)} GiB`;
          problems.push({
            id: `root_low_space:${root.id}`,
            message: free === null ? 'The folder {path} has little free space.' : 'The folder {path} has little free space ({free} free).',
            action: 'Free disk space.',
            params: free === null ? { path: root.path } : { path: root.path, free },
          });
        } else {
          problems.push({
            id: `root_${problem}:${root.id}`,
            ...rootText[problem],
            params: { path: root.path },
            ...(problem === 'mount_changed' ? { fix: { kind: 'accept_mount' as const, rootId: root.id } } : {}),
          });
        }
      }
    }),
  );

  const indexers = Object.values(db.data.indexers);
  if (!indexers.length) {
    problems.push({ id: 'indexers_missing', message: 'No indexer is set.', action: 'Add an indexer in Settings.' });
  }
  for (const indexer of indexers) {
    if (indexer.health.failures > 0) {
      const name = (indexer.push.sonarr ?? indexer.push.radarr)?.name ?? `Indexer ${indexer.id}`;
      problems.push({ id: `indexer_failing:${indexer.id}`, message: 'The indexer {name} does not answer.', action: 'Check the indexer. The wait between attempts grows each time.', params: { name } });
    }
  }

  if (clientCheck) {
    const state = await clientCheck();
    if (state === 'unconfigured') problems.push({ id: 'client_missing', message: 'No download client is set.', action: 'Add qBittorrent in Settings.' });
    else if (state === 'rejected') problems.push({ id: 'client_rejected', message: 'The download client rejects the login.', action: 'Correct the login in the client settings.' });
    else if (state === 'unreachable') problems.push({ id: 'client_unreachable', message: 'The download client does not answer.', action: 'Start qBittorrent, or correct the address in the client settings.' });
  }
  if (ffprobe && !(await ffprobe())) {
    problems.push({ id: 'ffprobe_missing', message: 'ffprobe is not installed, so files get a basic check only.', action: 'Install ffmpeg.' });
  }

  if (backupDir) {
    const newest = (await listBackups(backupDir))[0];
    if (!newest || Date.now() - newest.createdAt > BACKUP_MAX_AGE_MS) {
      problems.push({ id: 'backup_stale', message: 'There is no recent backup.', action: 'Start a backup in Settings.' });
    }
  }
  return problems.sort((a, b) => a.id.localeCompare(b.id));
}
