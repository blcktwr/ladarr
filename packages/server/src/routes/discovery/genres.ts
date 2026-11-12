import type { DiscoveryGenre } from '@ladarr/shared/types';

// TMDB names some genres of series differently from the genres of movies. The filter has one list, so a name maps to
// the genre of each media type.
const SERIES_NAMES: Record<string, string> = {
  Action: 'Action & Adventure',
  Adventure: 'Action & Adventure',
  Fantasy: 'Sci-Fi & Fantasy',
  'Science Fiction': 'Sci-Fi & Fantasy',
  War: 'War & Politics',
};

type Genre = { id: number; name: string };

// The genres of the filter. The list starts with the genres of movies, each one with the genre of series of the same
// name or of its equivalent, and then holds the genres that only series have.
export function discoveryGenres(movies: Genre[], series: Genre[]): DiscoveryGenre[] {
  const seriesByName = new Map(series.map((genre) => [genre.name, genre.id]));
  const used = new Set<number>();
  const genres: DiscoveryGenre[] = movies.map((genre) => {
    const tv = seriesByName.get(SERIES_NAMES[genre.name] ?? genre.name) ?? null;
    if (tv !== null) used.add(tv);
    return { name: genre.name, movie: genre.id, tv };
  });
  for (const genre of series) if (!used.has(genre.id)) genres.push({ name: genre.name, movie: null, tv: genre.id });
  return genres;
}
