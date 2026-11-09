// TMDB gives a region for each alias, not a language. The likely language of a region is the one that Intl gives to
// the undetermined language in that region, for example und-MA -> ar and und-TH -> th.
export function languageOfRegion(region: string): string {
  try {
    return new Intl.Locale(`und-${region}`).maximize().language;
  } catch {
    return region.toLowerCase();
  }
}
