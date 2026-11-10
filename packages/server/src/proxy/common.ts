import type { MediaType } from '@ladarr/shared/enums';
import type { RequestHandler, Response } from 'express';
import type { Services } from '../app.ts';
import { profilesInOrder, type Db, type Root } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import type { Title } from '../library/library.ts';
import { TmdbError, type TitleMeta, type Tmdb } from '../metadata/tmdb.ts';

export type CompatDeps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; services?: Services };

// A command that a caller sent. A search command lists the entries that it started and the search jobs of those entries.
// The search ends when its jobs end, so a command that a restart interrupted still ends, and a later search of the same entry does not change it.
export type CompatCommand = {
  id: number;
  name: string;
  body: Record<string, unknown>;
  queuedAt: number;
  endedAt: number | null;
  status: 'queued' | 'started' | 'completed' | 'failed';
  message: string | null;
  entries: string[];
  jobs: string[];
};

export const notFound = (res: Response, detail: string) => void res.status(404).json({ message: 'NotFound', detail });

// A path outside the prefix of a proxy port.
export const notFoundPath = (path: string): RequestHandler => (_req, res) => void res.status(404).json({ message: 'NotFound', detail: `Use ${path}.` });
export const notSupported = (res: Response, detail: string) => void res.status(501).json({ message: 'NotSupported', detail });
export const refuse = (res: Response, errors: [property: string, message: string][]) =>
  void res.status(400).json(errors.map(([propertyName, errorMessage]) => ({ propertyName, errorMessage, severity: 'error' })));

// Turns a failure of TMDB into an answer. The caller handles `not_found` first.
export function tmdbProblem(res: Response, error: unknown) {
  if (!(error instanceof TmdbError)) throw error;
  res.status(503).json({ message: 'ServiceUnavailable', detail: error.code === 'invalid_key' ? 'TMDB rejects the API key.' : 'TMDB does not answer.' });
}

export const noTmdb = (res: Response) => void res.status(503).json({ message: 'ServiceUnavailable', detail: 'The TMDB key is not set.' });

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const parseId = (text: unknown) => (typeof text === 'string' && /^[1-9]\d{0,9}$/.test(text) ? Number(text) : undefined);

// The two profiles of version 1 are the numbers 1 and 2. A profile that the user makes has a number as its ID.
const SEED_NUMBER: Record<string, number> = { p1080: 1, p2160: 2 };
export const profileId = (id: string) => SEED_NUMBER[id] ?? Number(id);
export const presetOf = (db: Db, number: unknown) => (Number.isInteger(number) ? profilesInOrder(db.data).map((profile) => profile.id).find((id) => profileId(id) === number) : undefined);
export const profiles = (db: Db) => profilesInOrder(db.data).map((profile) => ({ id: profileId(profile.id), name: profile.name }));
// The profile that a title without a profile of its own uses: the first one of the chain.
export const firstProfileId = (db: Db) => profilesInOrder(db.data)[0]!.id;

// Roots have text IDs. A caller needs a number, so the number comes from the text and stays the same.
export function rootNumber(id: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return ((hash >>> 0) % 2147483646) + 1;
}
const trimmed = (path: string) => path.replace(/\/+$/, '') || '/';
export const rootsOf = (db: Db, mediaType: MediaType) => Object.values(db.data.roots).filter((root) => root.mediaType === mediaType);
export const findRoot = (db: Db, mediaType: MediaType, path: unknown) => (typeof path === 'string' ? rootsOf(db, mediaType).find((root) => trimmed(root.path) === trimmed(path)) : undefined);

// A time span in the text form of Sonarr and Radarr: "hh:mm:ss", or "d.hh:mm:ss" from one day.
export function timespan(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const time = new Date((seconds % 86_400) * 1000).toISOString().slice(11, 19);
  return days ? `${days}.${time}` : time;
}

export const clock = (db: Db) => ({ now: Date.now(), timeZone: db.data.settings.timeZone, region: db.data.settings.region, files: db.data.files });

export const hasFiles = (title: Title) => Boolean(title.fileId) || title.episodes.some((episode) => episode.fileId);

export function presentFile(db: Db, fileId: string | null) {
  const file = fileId ? db.data.files[fileId] : undefined;
  return file && !file.missing ? file : undefined;
}

// A title that is not in the library yet. A lookup shows it with the same builders as a title of the library.
export function candidate(meta: TitleMeta): Title {
  const now = Date.now();
  return {
    key: `${meta.mediaType}:${meta.tmdbId}`,
    mediaType: meta.mediaType,
    tmdbId: meta.tmdbId,
    meta,
    refreshedAt: now,
    addedAt: now,
    paused: true,
    policy: 'all',
    futureFrom: now,
    seriesType: 'standard',
    preset: null,
    rootId: '',
    folder: null,
    manualRelease: false,
    seasonOverrides: {},
    episodesLoadedAt: null,
    episodes: [],
    fileId: null,
  };
}

export type Placement = { preset: string; root: Root; monitored: boolean };

// The fields that Seerr sends to place a title: profile, root folder, monitored, and tags.
export function readPlacement(db: Db, mediaType: MediaType, body: Record<string, unknown>): Placement | { errors: [string, string][] } {
  const errors: [string, string][] = [];
  const preset = presetOf(db, body.qualityProfileId ?? body.profileId);
  if (!preset) errors.push(['qualityProfileId', 'No quality profile has this ID.']);
  const root = findRoot(db, mediaType, body.rootFolderPath);
  if (!root) errors.push(['rootFolderPath', 'No root folder has this path.']);
  if (body.monitored !== undefined && typeof body.monitored !== 'boolean') errors.push(['monitored', 'The value must be true or false.']);
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length)) errors.push(['tags', 'Tags are not supported. Send an empty list.']);
  return errors.length ? { errors } : { preset: preset!, root: root!, monitored: body.monitored !== false };
}

// addOptions: only the fields in `allowed` are known. Another field is an error, so no option is dropped without a word.
export function readOptions(body: Record<string, unknown>, allowed: string[]): { search: boolean } | { errors: [string, string][] } {
  const options = body.addOptions ?? {};
  if (!isObject(options)) return { errors: [['addOptions', 'The value must be an object.']] };
  const unknown = Object.keys(options).filter((name) => !allowed.includes(name));
  if (unknown.length) return { errors: [['addOptions', `Unsupported options: ${unknown.join(', ')}.`]] };
  const flag = allowed.find((name) => name.startsWith('searchFor'))!;
  if (options[flag] !== undefined && typeof options[flag] !== 'boolean') return { errors: [[`addOptions.${flag}`, 'The value must be true or false.']] };
  return { search: options[flag] === true };
}
