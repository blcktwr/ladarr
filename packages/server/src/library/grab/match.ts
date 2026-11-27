import type { EpisodeRef, Numbering, Title } from '../../types.ts';
import { inspectCoverage } from '../coverage.ts';
import { isSample, isVideoFile } from '../parse.ts';

type Manifest = ReturnType<typeof inspectCoverage>;

const key = ({ season, number }: EpisodeRef) => `${season}:${number}`;

export function matchMovie(files: readonly string[], selected?: string | null) {
  const videos = files.filter((file) => isVideoFile(file) && !isSample(file));
  if (!videos.length) return { file: null, problem: 'no_video' } as const;
  const file = selected != null ? videos.find((file) => file === selected) : videos.length === 1 ? videos[0] : undefined;
  return file ? { file, problem: null } : { file: null, problem: 'file_unmapped' } as const;
}

export function validMatches(files: string[], title: Title, matches: Record<string, EpisodeRef[]>) {
  const paths = new Set(files.filter((file) => isVideoFile(file) && !isSample(file)));
  const known = new Set(title.episodes.map(key));
  const assigned = new Set<string>();
  return Object.entries(matches).every(([file, points]) => paths.has(file) && points.length > 0 && points.every((point) => {
    const id = key(point);
    if (!known.has(id) || assigned.has(id)) return false;
    assigned.add(id);
    return true;
  }));
}

export function readCoverage(files: string[], title: Title, numbering: Numbering, matches?: Record<string, EpisodeRef[]>, seasonHint?: number | null): Manifest {
  const manifest = inspectCoverage(matches ? files.filter((file) => !Object.hasOwn(matches, file)) : files, title, numbering, seasonHint);
  if (!matches) return manifest;
  const manual = Object.values(matches).flat();
  const assigned = new Set(manual.map(key));
  const byFile = new Map(Object.entries(matches));
  for (const [file, points] of manifest.byFile) byFile.set(file, points.filter((point) => !assigned.has(key(point))));
  return {
    ...manifest, byFile, episodes: [...manual, ...manifest.episodes.filter((point) => !assigned.has(key(point)))],
    status: (point) => assigned.has(key(point)) ? 'identified'
      : !manifest.unknown.length && !manifest.episodes.length && manual.length ? 'absent' : manifest.status(point),
  };
}

export function matchCompletePack(manifest: Manifest, requested: EpisodeRef[]) {
  return requested.length > 0 && requested.every((target) => manifest.status(target) === 'identified');
}

export function matchPartialPack(manifest: Manifest, requested: EpisodeRef[]) {
  const covered = requested.filter((target) => manifest.status(target) === 'identified');
  const missing = requested.filter((target) => manifest.status(target) === 'absent');
  return { covered, missing };
}

export function matchEpisode(manifest: Manifest, requested: EpisodeRef) {
  return manifest.status(requested) === 'identified';
}

export function needsManualMapping(manifest: Manifest, requested: EpisodeRef[]) {
  const episodes = requested.filter((target) => manifest.status(target) === 'unknown');
  return episodes.length && manifest.unknown.length ? { episodes, files: manifest.unknown } : null;
}

export function fileOf(manifest: Manifest, target: EpisodeRef) {
  return [...manifest.byFile].find(([, episodes]) => episodes.some(({ season, number }) => season === target.season && number === target.number))?.[0] ?? null;
}
