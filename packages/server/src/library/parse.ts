export type ParsedEpisodes = { season: number; numbers: number[] };

const MAX_RANGE = 50;
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|webm)$/i;
const SAMPLE = /(^|[^a-z0-9])sample([^a-z0-9]|$)/i;

export const isVideoFile = (name: string) => VIDEO.test(name);
// A sample is a short clip of a release. It is not the title.
export const isSample = (path: string) => SAMPLE.test(path);

// Reads the season and the episodes from a file name: S01E02, S01E02E03, S01E02-E04, S01E02-04, or 1x02.
// A name that gives no season and episode returns nothing, so the file stays unmatched.
export function parseEpisodes(name: string): ParsedEpisodes | undefined {
  // More episodes follow as E03 (with or without a separator), or as -E04 or -04 (a range).
  const sxe = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})((?:[ ._-]?e\d{1,3}|-e?\d{1,3}(?!\d))*)/i.exec(name);
  const nxn = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?(?![0-9a-z])/i.exec(name);
  const found = sxe ?? nxn;
  if (!found) return;

  const season = Number(found[1]);
  const first = Number(found[2]);
  const numbers = [first];
  if (sxe && sxe[3]) {
    // The rest of the match holds more episodes: E03, -E04, or -04. A dash between two numbers is a range.
    const tail = [...sxe[3].matchAll(/(-?)[ ._-]*e?(\d{1,3})/gi)];
    let previous = first;
    for (const [, dash, digits] of tail) {
      const next = Number(digits);
      if (dash && next > previous && next - previous <= MAX_RANGE) for (let n = previous + 1; n <= next; n++) numbers.push(n);
      else numbers.push(next);
      previous = next;
    }
  } else if (nxn && nxn[3]) {
    const last = Number(nxn[3]);
    if (last > first && last - first <= MAX_RANGE) for (let n = first + 1; n <= last; n++) numbers.push(n);
  }
  return { season, numbers: [...new Set(numbers)] };
}

// A title can number the episodes of a season across the whole series, while a release starts again at 1 in each season.
// This gives the numbers of the title for the numbers of a file. A number that is already an episode of the season stays,
// and the other numbers are the position in the season. A number that is neither is not a match and is left out.
export function titleNumbers(parsed: ParsedEpisodes, episodes: { season: number; number: number }[]): number[] {
  const season = episodes.filter((episode) => episode.season === parsed.season).map((episode) => episode.number).sort((a, b) => a - b);
  const known = new Set(season);
  return parsed.numbers.flatMap((number) => {
    if (known.has(number)) return [number];
    const at = season[number - 1];
    return at === undefined ? [] : [at];
  });
}
