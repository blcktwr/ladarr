import type { ParsedRelease, ReleaseSource } from '../../types.ts';

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

// The words of a release name, from the point where its title ends.
const wordsOf = (value: string) => value.split(/[^a-z0-9+]+/).filter(Boolean);

// The words that a release name uses for its own fields, after a language tag.
const FIELD_WORDS = /^(?:\d{3,4}[pi]|4k|uhd|web|webdl|webrip|rip|bluray|bdremux|remux|bdrip|brrip|rawhd|hdtv|sdtv|pdtv|dvdrip|dvd|hdcam|cam|hdts|ts|telecine|tc|x264|x265|h264|h265|hevc|avc|av1|10bit|8bit|dts|dtshd|truehd|atmos|aac|ac3|eac3|dd|ddp|ddp5|flac|proper|repack|extended|remastered|uncut|internal|complete|limited|hybrid|hdr|dv)$/i;
const AUDIO_WORDS = new Set(['multi', 'dual', 'dl', 'sub', 'subs', 'subbed', 'dub', 'dubbed', 'vf', 'vo', 'vostfr', 'truefrench', 'vff']);

// True when the word at that place is a field of the release and not a word of its episode name. The words of the
// episode name come right after the episode marker, and no field word comes between a tag and the quality marker.
function isTag(words: string[], index: number) {
  for (let next = index + 1; next < words.length && next <= index + 3; next++) {
    const word = words[next]!;
    if (LANGUAGES[word] || AUDIO_WORDS.has(word)) continue;
    return FIELD_WORDS.test(word) || next === words.length - 1;
  }
  return true;
}

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

  // Season markers: S01, Season 1, S01-S03, Seasons 1-3. They count only when there is no episode. A name that lists
  // several seasons holds more than one, also when it writes them one by one.
  let pack = false;
  let part = false;
  let multiSeason = false;
  let absolute: number | null = null;
  if (!episodeMatch) {
    const range = /(?:^|[^a-z0-9])s(?:eason)?s?[ ._]?(\d{1,2})[ ._]?(?:-|to|&|\+)[ ._]?s?(?:eason)?[ ._]?(\d{1,2})(?![0-9a-z])/i.exec(spaced);
    const markers = [...spaced.matchAll(/(?:^|[^a-z0-9])(?:s|season[ ._]?)(\d{1,2})(?![0-9a-z])/gi)];
    const one = markers[0];
    if (range && Number(range[2]) > Number(range[1])) {
      multiSeason = true;
      markerAt = range.index + 1;
    } else if (one && new Set(markers.map((marker) => Number(marker[1]))).size > 1) {
      multiSeason = true;
      markerAt = one.index + (/^[^a-z0-9]/.test(one[0]) ? 1 : 0);
    } else if (one) {
      pack = true;
      season = Number(one[1]);
      markerAt = one.index + (/^[^a-z0-9]/i.test(one[0]) ? 1 : 0);
      // A split season gives one part of its episodes, so the name does not cover the season.
      if (/(?:^|[^a-z0-9])part[ ._-]?\d(?![0-9a-z])/i.test(spaced)) {
        part = true;
        pack = false;
      }
    }
    // An anime release gives the absolute number of the episode, with no season and episode.
    const numberAt = /(?:^|[^a-z0-9])-\s*(\d{1,3})(?:v\d{1,2})?\s*(?=$|[[(])/i.exec(spaced);
    if (!pack && !multiSeason && numberAt) {
      absolute = Number(numberAt[1]);
      markerAt = numberAt.index + (/^[^a-z0-9]/.test(numberAt[0]) ? 1 : 0);
    }
  }

  const daily = /(?:^|[^0-9])((?:19|20)\d{2})[ ._-](0[1-9]|1[0-2])[ ._-](0[1-9]|[12]\d|3[01])(?![0-9])/.exec(spaced);
  const airDate = daily && !episodeMatch ? `${daily[1]}-${daily[2]}-${daily[3]}` : null;
  if (airDate) markerAt = Math.min(markerAt, daily!.index + (/^[^0-9]/.test(daily![0]) ? 1 : 0));

  // Quality markers. A size that the name gives as a number wins over the 4K of the branding, and an interlaced file
  // counts as its size.
  const dimensionMatch = /(?:^|[^a-z0-9])(\d{3,4})[pi](?![a-z0-9])/i.exec(spaced);
  const brandingMatch = /(?:^|[^a-z0-9])(4k|uhd)(?![a-z0-9])/i.exec(spaced);
  const resolutionMatch = dimensionMatch ?? brandingMatch;
  const resolution = dimensionMatch ? Number(dimensionMatch[1]) : brandingMatch ? 2160 : null;
  const at = (match: RegExpMatchArray) => (match.index ?? 0) + (/^[^a-z0-9]/i.test(match[0]) ? 1 : 0);
  const resolutionAt = resolutionMatch ? at(resolutionMatch) : null;
  // The source marker comes after the title and its year. A word of the title that looks like one, such as "Web" in
  // "Madame Web", stays in the title.
  const years = [...spaced.matchAll(/(?:^|[^0-9])(?:19|20)\d{2}(?![0-9])/g)].map(at);
  const sourceMatches = [...spaced.matchAll(/(?:^|[^a-z0-9])(web[ .-]?dl|web[ .-]?rip|webrip|web|blu[ .-]?ray|bdremux|remux|bdrip|brrip|raw[ .-]?hd|hdtv|sdtv|pdtv|dvdrip|dvd|hdcam|cam|hdts|telesync|ts|telecine|tc)(?![a-z0-9])/gi)].filter(
    (match) => !years.some((year) => year > at(match)),
  );
  const keyOf = (match: RegExpMatchArray) => match[1]!.toLowerCase().replace(/[ .-]/g, '');
  // A remux or a raw capture wins over the BluRay or HDTV marker before it, and a marker after the resolution wins over
  // one before it.
  const after = resolutionAt === null ? sourceMatches : sourceMatches.filter((match) => at(match) >= resolutionAt);
  const sourceMatch = sourceMatches.find((match) => /^(bdremux|remux|rawhd)$/.test(keyOf(match))) ?? after[0] ?? sourceMatches[0];
  const key = sourceMatch ? keyOf(sourceMatch) : undefined;
  const source: ReleaseSource =
    key === 'webdl' || key === 'web' ? 'webdl'
    : key === 'webrip' ? 'webrip'
    : key && /^(bdremux|remux)$/.test(key) ? 'remux'
    : key && /^(bluray|bdrip|brrip)$/.test(key) ? 'bluray'
    : key === 'rawhd' ? 'rawhd'
    : key === 'hdtv' ? 'hdtv'
    : key === 'sdtv' || key === 'pdtv' ? 'sdtv'
    : key && /^(dvdrip|dvd)$/.test(key) ? 'dvd'
    : key && /^(hdcam|cam)$/.test(key) ? 'cam'
    : key && /^(hdts|telesync|ts|telecine|tc)$/.test(key) ? 'telesync'
    : 'unknown';
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

  // Language words only count after the title, so a title like "The Italian Job" keeps its meaning. A language word
  // that the words of the episode name follow is not a tag: "The.French.Connection" is not a French audio.
  const found = new Set<string>();
  const tail = wordsOf(spaced.slice(end).toLowerCase());
  for (const [index, word] of tail.entries()) {
    if (!isTag(tail, index)) continue;
    const language = LANGUAGES[word];
    if (language) found.add(language);
    else if (word === 'multi' || word === 'dual') found.add('multi');
  }
  const audioLanguages = found.size ? [...found] : null;

  return { title, year, season, episodes, pack, part, multiSeason, absolute, airDate, resolution, source, group, audioLanguages };
}

// Compares titles without case, accents, punctuation, a leading article, or the year in brackets.
export function normalizeTitle(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}
