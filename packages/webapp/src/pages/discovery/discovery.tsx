import type { DiscoveryFilters, DiscoveryPage, DiscoverySort, WatchProvider } from '@ladarr/shared/types';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { Button, Dropdown, EmptyState, Field, Gallery, Panel, SearchField, Spinner, Text, Tile } from 'nebula';
import { useEffect, useRef, useState } from 'react';
import { LoadFailed } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { posterUrl } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { ResultItem } from '../search/result-item.tsx';

// The page has the margins of the app, as the catalog does.
const page = 'grid gap-8 p-6';
// The title has a centered column, and its content aligns at its left edge.
const column = 'mx-auto w-[min(1200px,calc(100%-40px))]';
// The rows span the window. The column is as wide as the columns of thumbnails that fit in it, so the room that a
// column does not fill goes in equal parts to each side (10rem per thumbnail and 1.5rem between them).
const tiles = 'mx-auto w-[calc(round(down,calc(100%+1.5rem),11.5rem)-1.5rem)]';

// The filters of the panel. An empty value leaves its filter out. The streaming services start in the United States.
type Filters = { from: string; to: string; genre: string; region: string; providers: number[] };
const noFilters: Filters = { from: '', to: '', genre: '', region: 'US', providers: [] };

// A country can have hundreds of services, so the panel shows a part of them at a time.
const servicesShown = 40;

// The filter lists change rarely, so the page keeps them for a day.
const listsTtl = 24 * 60 * 60_000;

// The filters of the discovery page. The genres of movies and series share one list, and the server maps each one to
// the genre of the two media types. The streaming services belong to the country of the list.
function FilterPanel({ filters, lists, providers, onChange }: { filters: Filters; lists?: DiscoveryFilters; providers?: WatchProvider[]; onChange: (filters: Filters) => void }) {
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(servicesShown);
  const term = search.trim().toLowerCase();
  const matches = (providers ?? []).filter((provider) => provider.name.toLowerCase().includes(term));
  // A service that is on in the country turns on, and the others turn off. A new country starts with no service.
  const toggleProvider = (id: number, checked: boolean) =>
    onChange({
      ...filters,
      providers: checked ? [...filters.providers, id] : filters.providers.filter((other) => other !== id),
    });

  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t('From')}
          type="date"
          width="full"
          value={filters.from}
          onChange={(event) => onChange({ ...filters, from: event.target.value })}
        />
        <Field
          label={t('To')}
          type="date"
          width="full"
          value={filters.to}
          onChange={(event) => onChange({ ...filters, to: event.target.value })}
        />
      </div>
      <Dropdown
        label={t('Genre')}
        width="full"
        value={filters.genre}
        options={[
          { value: '', label: t('All genres') },
          ...(lists?.genres ?? []).map((genre) => ({ value: genre.name, label: genre.name })),
        ]}
        onValueChange={(value) => onChange({ ...filters, genre: value ?? '' })}
      />
      <div className="grid gap-3">
        <Dropdown
          label={t('Country')}
          width="full"
          reserve={false}
          value={filters.region}
          options={(lists?.regions ?? []).map((region) => ({ value: region.code, label: region.name }))}
          onValueChange={(value) => {
            onChange({ ...filters, region: value ?? 'US', providers: [] });
            setSearch('');
            setShown(servicesShown);
          }}
        />
        <SearchField
          aria-label={t('Search services')}
          placeholder={t('Search services')}
          value={search}
          onChange={(value) => {
            setSearch(value);
            setShown(servicesShown);
          }}
        />
        <div className="grid grid-cols-5 gap-1.5">
          {matches.slice(0, shown).map((provider) => (
            <Tile
              key={provider.id}
              label={provider.name}
              image={posterUrl(provider.logoPath, 'w92')}
              selected={filters.providers.includes(provider.id)}
              onSelectedChange={() => toggleProvider(provider.id, !filters.providers.includes(provider.id))}
            />
          ))}
        </div>
        {matches.length > shown && (
          <Button variant="ghost" className="justify-self-start" onClick={() => setShown(shown + servicesShown)}>
            {t('Show more')}
          </Button>
        )}
      </div>
    </div>
  );
}

// The titles of TMDB that the catalog does not have yet. A poster opens the title page, and its button adds it.
export function Discovery() {
  const [sort, setSort] = useState<DiscoverySort>('popularity.desc');
  const [filters, setFilters] = useState<Filters>(noFilters);
  // The lists of the filter panel load with the page, so the panel opens with them ready. The server keeps them for a
  // day, so the page asks for them again only after that.
  const lists = useQuery<DiscoveryFilters>({ queryKey: ['/discovery/filters'], staleTime: listsTtl });
  const providers = useQuery<WatchProvider[]>({
    queryKey: ['/discovery/providers', filters.region],
    queryFn: () => api<WatchProvider[]>(`/discovery/providers?region=${filters.region}`),
    staleTime: listsTtl,
  });
  const sorts: { value: DiscoverySort; label: string }[] = [
    { value: 'popularity.asc', label: t('Popularity (asc)') },
    { value: 'popularity.desc', label: t('Popularity (desc)') },
    { value: 'release.asc', label: t('Release date (asc)') },
    { value: 'release.desc', label: t('Release date (desc)') },
    { value: 'rating.asc', label: t('TMDB rating (asc)') },
    { value: 'rating.desc', label: t('TMDB rating (desc)') },
  ];
  const params = new URLSearchParams({ sort });
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.genre) params.set('genre', filters.genre);
  // A watch provider needs the country of its list.
  if (filters.providers.length) {
    params.set('region', filters.region);
    params.set('providers', filters.providers.join(','));
  }
  const query = `/discovery?${params.toString()}`;
  const { data, error, isFetchingNextPage, fetchNextPage, hasNextPage, refetch } = useInfiniteQuery({
    queryKey: [query],
    queryFn: ({ pageParam }) => api<DiscoveryPage>(`${query}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  const pages = data?.pages ?? [];
  // Each row holds the results of every page that the page has.
  const rows = (pages[0]?.rows ?? []).map((row) => ({
    ...row,
    results: pages.flatMap((page) => page.rows.find((other) => other.id === row.id)?.results ?? []),
  }));
  const shown = rows.filter((row) => row.results.length > 0);
  // The end of the page takes the next page before it reaches the screen.
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = more.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage && !error) void fetchNextPage();
    }, { rootMargin: '600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [error, fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <div className={page}>
      <div className={`${column} flex flex-wrap items-center justify-between gap-4`}>
        <Text variant="title">{t('Discovery')}</Text>
        <div className="flex items-center gap-4">
          <Dropdown value={sort} options={sorts} onValueChange={(value) => setSort((value ?? 'popularity.desc') as DiscoverySort)} />
          <Panel
            label={t('Filters')}
            title={t('Apply filter')}
            trigger={
              <Button iconOnly aria-label={t('Filters')}>
                <SlidersHorizontal />
              </Button>
            }
          >
            <FilterPanel filters={filters} lists={lists.data} providers={providers.data} onChange={setFilters} />
          </Panel>
        </div>
      </div>
      {error && !data ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : !data ? (
        <div className="grid min-h-96 place-items-center">
          <Spinner size="lg" label={t('Loading')} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState>{t('No titles.')}</EmptyState>
      ) : (
        shown.map((row) => (
          <div key={row.id} className={tiles}>
            <Gallery>
              {row.results.map((result) => (
                <ResultItem key={`${result.mediaType}:${result.tmdbId}`} result={result} />
              ))}
            </Gallery>
          </div>
        ))
      )}
      {hasNextPage && <div ref={more} aria-hidden="true" className="h-px" />}
    </div>
  );
}
