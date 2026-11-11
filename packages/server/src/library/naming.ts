import { extname } from 'node:path';
import type { Title } from './library.ts';
import { parseEpisodes } from './parse.ts';

// Removes what a file system does not allow, and the dots and spaces at the ends of a name.
export function sanitize(name: string) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 150)
    .replace(/[. ]+$/g, '');
}

const pad = (value: number) => String(value).padStart(2, '0');

// The name of a file, without its folders and its extension. The folders stay fixed, so a template can not leave the title folder.
export type NamingTemplates = { movie: string; episode: string };

export const DEFAULT_NAMING: NamingTemplates = { movie: '{title} ({year})', episode: '{title} - S{season}E{episode} - {episodeTitle}' };

const TOKENS = { movie: ['title', 'year'], episode: ['title', 'year', 'season', 'episode', 'episodeTitle'] } as const;
// An episode name must be different for each episode, so these tokens are necessary.
const NECESSARY = { movie: ['title'], episode: ['title', 'season', 'episode'] } as const;
const MAX_TEMPLATE = 150;

export type TemplateProblem = 'template_invalid' | 'template_separator' | 'template_token' | 'template_missing_token' | 'template_unreadable';

// Returns the problem of a template, or null when it is valid.
export function templateProblem(kind: 'movie' | 'episode', template: unknown): TemplateProblem | null {
  if (typeof template !== 'string' || !template.trim() || template.length > MAX_TEMPLATE) return 'template_invalid';
  if (/[/\\\u0000-\u001f]/.test(template)) return 'template_separator';
  const used = [...template.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!);
  if (used.some((token) => !(TOKENS[kind] as readonly string[]).includes(token))) return 'template_token';
  // A brace that is not part of a token.
  if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ''))) return 'template_token';
  if (NECESSARY[kind].some((token) => !used.includes(token))) return 'template_missing_token';
  if (kind === 'episode' && !readable(template)) return 'template_unreadable';
  return null;
}

// A rescan reads the season and the episodes from the name of a file. A name that it can not read would make the file missing.
// So the name of one episode and the name of two episodes must give back the same season and episodes.
function readable(template: string) {
  const sample = { meta: { title: 'Show Name', year: 2020 }, tmdbId: 1 } as Title;
  return [[2], [2, 3]].every((numbers) => reads(render(template, episodeValues(sample, numbers.map((number) => ({ season: 1, number, name: 'Episode Name' })))) + '.mkv', 1, numbers));
}

// True when a scan reads the season and the episodes back from the name.
function reads(name: string, season: number, numbers: number[]) {
  const found = parseEpisodes(name);
  return found?.season === season && found.numbers.join() === numbers.join();
}

type NamedEpisode = { season: number; number: number; name: string };

function episodeValues(title: Title, episodes: NamedEpisode[]) {
  const first = episodes[0]!;
  return {
    title: title.meta.title,
    year: title.meta.year ? String(title.meta.year) : '',
    season: pad(first.season),
    episode: episodes.map((episode) => pad(episode.number)).join('E'),
    // A file for several episodes has no single episode title.
    episodeTitle: episodes.length === 1 ? first.name || `Episode ${first.number}` : '',
  };
}

function render(template: string, values: Record<string, string>) {
  return sanitize(
    template
      .replace(/\{([^{}]*)\}/g, (_match, token: string) => values[token] ?? '')
      // A token with no value leaves empty brackets or a lone separator. Remove them.
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/(?: -){2,}(?= |$)/g, ' -')
      .replace(/^(?:\s*- )+|(?: -\s*)+$/g, ''),
  );
}

// The folder of a title under its root: "Title (Year)".
export function folderName(title: Title) {
  const year = title.meta.year ? ` (${title.meta.year})` : '';
  return sanitize(`${title.meta.title}${year}`) || `title-${title.tmdbId}`;
}

// Adds a version label before the extension: "Title (Year) - 1080p.ext".
export function versionedPath(path: string, label: string) {
  const extension = extname(path);
  return `${path.slice(0, path.length - extension.length)} - ${label}${extension}`;
}

// The path of a movie file, relative to the root: "Title (Year)/Title (Year).ext".
export function moviePath(title: Title, folder: string, extension: string, templates: NamingTemplates = DEFAULT_NAMING) {
  const name = render(templates.movie, { title: title.meta.title, year: title.meta.year ? String(title.meta.year) : '' });
  return `${folder}/${name || folderName(title)}${extension}`;
}

// The path of an episode file: "Title (Year)/Season 01/Title - S01E02 - Name.ext".
// A file for several episodes lists them all: S01E02E03.
export function episodePath(title: Title, folder: string, episodes: NamedEpisode[], extension: string, templates: NamingTemplates = DEFAULT_NAMING) {
  const first = episodes[0]!;
  const values = episodeValues(title, episodes);
  const numbers = episodes.map((episode) => episode.number);
  // A name has 150 characters at most. A long title can push the season and the episode out of it, and a scan could not read the file.
  // So the long parts get shorter, and the last choice is the season and the episode alone.
  let name = `S${values.season}E${values.episode}`;
  for (const candidate of [values, { ...values, episodeTitle: values.episodeTitle.slice(0, 40) }, { ...values, episodeTitle: '' }, { ...values, title: values.title.slice(0, 40), episodeTitle: '' }]) {
    const rendered = render(templates.episode, candidate);
    if (reads(rendered + extension, first.season, numbers)) {
      name = rendered;
      break;
    }
  }
  const season = first.season === 0 ? 'Specials' : `Season ${pad(first.season)}`;
  return `${folder}/${season}/${name}${extension}`;
}

// The names that a pair of templates gives to a sample movie and a sample episode, for the preview in Settings.
export function exampleNames(templates: NamingTemplates) {
  const sample = { meta: { title: 'Show Name', year: 2020 }, tmdbId: 1 } as Title;
  const movie = moviePath({ meta: { title: 'Movie Name', year: 2019 }, tmdbId: 2 } as Title, '', '', templates).slice(1);
  const episode = episodePath(sample, '', [{ season: 1, number: 2, name: 'Episode Name' }], '', templates).split('/').pop()!;
  return { movie, episode };
}
