import type { ReleaseSource } from './quality.ts';

export type ParsedRelease = {
  // The words before the first marker, as the release spells them.
  title: string;
  year: number | null;
  season: number | null;
  episodes: number[];
  // True when the release is a whole season: it has a season and no episode.
  pack: boolean;
  // More than one season in one release. ladarr does not take these in the MVP.
  multiSeason: boolean;
  // YYYY-MM-DD for a daily show.
  airDate: string | null;
  resolution: number | null;
  source: ReleaseSource;
  group: string | null;
  // Null when the name does not say which audio the release has.
  audioLanguages: string[] | null;
};

const LANGUAGES: Record<string, string> = {
  german: 'de',
  french: 'fr',
  truefrench: 'fr',
  vff: 'fr',
  spanish: 'es',
  castellano: 'es',
  latino: 'es',
  italian: 'it',
  russian: 'ru',
  japanese: 'ja',
  korean: 'ko',
  portuguese: 'pt',
  dutch: 'nl',
  polish: 'pl',
  swedish: 'sv',
  english: 'en',
  eng: 'en',
};

const MAX_EPISODES = 50;
const SEPARATORS = /[._]+/g;

// Reads a release name like "Show.Name.S01E02.1080p.WEB-DL.DDP5.1.H.264-GROUP".
// It reads only what the name says. A value that the name does not give stays unknown.
export function parseRelease(name: string): ParsedRelease {
  let text = name.replace(/\.(torrent|mkv|mp4|avi)$/i, '');
  let group: string | null = null;
  const leading = /^\[([^\]]{1,40})\]\s*/.exec(text);
  if (leading) {
    group = leading[1]!;
    text = text.slice(leading[0].length);
  }
  const trailing = /-([A-Za-z0-9]{2,20})(?:\[[^\]]*\])?$/.exec(text);
  if (trailing && !group) group = trailing[1]!;
  const spaced = text.replace(SEPARATORS, ' ');

  // Episode markers.
  const sxe = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})((?:[ ._-]?e\d{1,3}|-e?\d{1,3}(?!\d))*)/i.exec(spaced);
  const nxn = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?(?![0-9a-z])/i.exec(spaced);
  const episodeMatch = sxe ?? nxn;
  let season: number | null = null;
  let episodes: number[] = [];
  let markerAt = Infinity;
  if (episodeMatch) {
    season = Number(episodeMatch[1]);
    const first = Number(episodeMatch[2]);
    episodes = [first];
    if (sxe?.[3]) {
      let previous = first;
      for (const [, dash, digits] of sxe[3].matchAll(/(-?)[ ._-]*e?(\d{1,3})/gi)) {
        const next = Number(digits);
        if (dash && next > previous && next - previous <= MAX_EPISODES) for (let n = previous + 1; n <= next; n++) episodes.push(n);
        else episodes.push(next);
        previous = next;
      }
    } else if (nxn?.[3]) {
      const last = Number(nxn[3]);
      if (last > first && last - first <= MAX_EPISODES) for (let n = first + 1; n <= last; n++) episodes.push(n);
    }
    episodes = [...new Set(episodes)];
    markerAt = episodeMatch.index + (/^[^a-z0-9]/i.test(episodeMatch[0]) ? 1 : 0);
  }

  // Season markers: S01, Season 1, S01-S03, Seasons 1-3. They count only when there is no episode.
  let pack = false;
  let multiSeason = false;
  if (!episodeMatch) {
    const range = /(?:^|[^a-z0-9])s(?:eason)?s?[ ._]?(\d{1,2})[ ._]?(?:-|to|&|\+)[ ._]?s?(?:eason)?[ ._]?(\d{1,2})(?![0-9a-z])/i.exec(spaced);
    const one = /(?:^|[^a-z0-9])(?:s|season[ ._]?)(\d{1,2})(?![0-9a-z])/i.exec(spaced);
    if (range && Number(range[2]) > Number(range[1])) {
      multiSeason = true;
      markerAt = range.index + 1;
    } else if (one) {
      pack = true;
      season = Number(one[1]);
      markerAt = one.index + (/^[^a-z0-9]/i.test(one[0]) ? 1 : 0);
    }
  }

  const daily = /(?:^|[^0-9])((?:19|20)\d{2})[ ._-](0[1-9]|1[0-2])[ ._-](0[1-9]|[12]\d|3[01])(?![0-9])/.exec(spaced);
  const airDate = daily && !episodeMatch ? `${daily[1]}-${daily[2]}-${daily[3]}` : null;
  if (airDate) markerAt = Math.min(markerAt, daily!.index + (/^[^0-9]/.test(daily![0]) ? 1 : 0));

  // Quality markers.
  const resolutionMatch = /(?:^|[^a-z0-9])(?:(\d{3,4})p|(4k|uhd))(?![a-z0-9])/i.exec(spaced);
  const resolution = resolutionMatch ? (resolutionMatch[2] ? 2160 : Number(resolutionMatch[1])) : null;
  const at = (match: RegExpMatchArray) => (match.index ?? 0) + (/^[^a-z0-9]/i.test(match[0]) ? 1 : 0);
  const resolutionAt = resolutionMatch ? at(resolutionMatch) : null;
  // The source marker comes after the resolution in a release name. A word of the title that looks like one, such as
  // "Web" in "Madame Web", stays in the title.
  const sourceMatches = [...spaced.matchAll(/(?:^|[^a-z0-9])(web[ .-]?dl|web[ .-]?rip|webrip|web|blu[ .-]?ray|bdrip|brrip|bdremux|remux|hdtv|pdtv|dvdrip|dvd|hdcam|cam|hdts|telesync|ts|telecine|tc)(?![a-z0-9])/gi)];
  const sourceMatch = (resolutionAt === null ? sourceMatches[0] : sourceMatches.find((match) => at(match) >= resolutionAt)) ?? sourceMatches[0];
  const key = sourceMatch?.[1]!.toLowerCase().replace(/[ .-]/g, '');
  const source: ReleaseSource =
    key === 'webdl' || key === 'web' ? 'webdl' : key === 'webrip' ? 'webrip' : key && /^(bluray|bdrip|brrip|bdremux|remux)$/.test(key) ? 'bluray' : key === 'hdtv' || key === 'pdtv' ? 'hdtv' : key && /^(dvdrip|dvd)$/.test(key) ? 'dvd' : key && /^(hdcam|cam)$/.test(key) ? 'cam' : key && /^(hdts|telesync|ts|telecine|tc)$/.test(key) ? 'telesync' : 'unknown';
  const qualityAt = Math.min(resolutionAt ?? Infinity, sourceMatch ? at(sourceMatch) : Infinity);

  // The year is the last year-like number before the first quality marker. A title can start with a number.
  let year: number | null = null;
  let yearAt = Infinity;
  if (!airDate) {
    const limit = Math.min(markerAt, qualityAt);
    for (const match of spaced.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/g)) {
      const at = match.index + (/^[^0-9]/.test(match[0]) ? 1 : 0);
      // A year at the very start is part of the title when something follows it.
      if (at >= limit || (at === 0 && spaced.length > 4)) continue;
      year = Number(match[1]);
      yearAt = at;
    }
  }

  const end = Math.min(markerAt, yearAt, qualityAt, spaced.length);
  const title = spaced.slice(0, end).replace(/[\s(\[-]+$/, '').trim();

  // Language words only count after the title, so a title like "The Italian Job" keeps its meaning.
  const tail = spaced.slice(end).toLowerCase();
  const found = new Set<string>();
  for (const word of tail.split(/[^a-z0-9]+/)) if (LANGUAGES[word]) found.add(LANGUAGES[word]!);
  if (/\b(multi|dual)\b/.test(tail)) found.add('multi');
  const audioLanguages = found.size ? [...found] : null;

  return { title, year, season, episodes, pack, multiSeason, airDate, resolution, source, group, audioLanguages };
}

// Compares titles without case, accents, punctuation, a leading article, or the year in brackets.
export function normalizeTitle(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}
