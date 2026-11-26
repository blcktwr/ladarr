import type { DiscoveryFilters, DiscoveryPage, DiscoverySort, WatchProvider } from '@ladarr/shared/types';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { Button, Dropdown, EmptyState, Field, Gallery, Panel, SearchField, Slider, Spinner, SubMenu, Text, Tile } from 'nebula';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { posterUrl } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { ResultItem } from '../search/result-item.tsx';
import { useSelection } from '../library/library-bulk.tsx';

// The page has the margins of the app, as the catalog does.
const page = 'grid gap-8 p-6';
// The title has a centered column, and its content aligns at its left edge.
const column = 'mx-auto w-[min(1200px,calc(100%-40px))]';
// The rows span the window. The column is as wide as the columns of thumbnails that fit in it, so the room that a
// column does not fill goes in equal parts to each side (10rem per thumbnail and 1.5rem between them).
const tiles = 'mx-auto w-[calc(round(down,calc(100%+1.5rem),11.5rem)-1.5rem)]';

// The filters of the panel. An empty value leaves its filter out. The streaming services start in the United States.
type Rating = readonly [number, number];
type Filters = { from: string; to: string; genre: string; rating: Rating; region: string; providers: number[] };

const ratingOf = (value: string | null, fallback: number) => {
  const rating = Number(value?.trim() || fallback);
  return rating >= 0 && rating <= 10 ? rating : fallback;
};

// A country can have hundreds of services, so the panel shows a part of them at a time.
const servicesShown = 40;

// The filter lists change rarely, so the page keeps them for a day.
const listsTtl = 24 * 60 * 60_000;

// The filters of the discovery page. The genres of movies and series share one list, and the server maps each one to
// the genre of the two media types. The streaming services belong to the country of the list.
function FilterPanel({ filters, lists, providers, onChange }: { filters: Filters; lists?: DiscoveryFilters; providers?: WatchProvider[]; onChange: (filters: Filters) => void }) {
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(servicesShown);
  const [rating, setRating] = useState<Rating>();
  const [ratingMin, ratingMax] = filters.rating;
  useEffect(() => setRating(undefined), [ratingMin, ratingMax]);
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
      <div>
        <Text variant="small">{t('TMDB rating')}</Text>
        <Slider
          label={[t('Minimum TMDB rating'), t('Maximum TMDB rating')]}
          min={0}
          max={10}
          step={0.1}
          stagger={20}
          thumbCollisionBehavior="none"
          value={rating ?? filters.rating}
          formatValue={(value) => String(value)}
          onValueChange={setRating}
          onValueCommitted={(value) => {
            if (value[0] !== ratingMin || value[1] !== ratingMax) onChange({ ...filters, rating: value });
          }}
        />
      </div>
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
  const [params, setParams] = useSearchParams();
  const term = params.get('q')?.trim() ?? '';
  const selectedType = params.get('type');
  const type = selectedType === 'movie' || selectedType === 'tv' ? selectedType : 'all';
  const ratingMin = ratingOf(params.get('ratingMin'), 0);
  const ratingMax = ratingOf(params.get('ratingMax'), 10);
  const filters: Filters = {
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    genre: params.get('genre') ?? '',
    rating: ratingMin <= ratingMax ? [ratingMin, ratingMax] : [0, 10],
    region: params.get('region') || 'US',
    providers: (params.get('providers') ?? '').split(',').filter((id) => /^\d+$/.test(id)).map(Number),
  };
  function update(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(values)) {
      if (value) next.set(name, value);
      else next.delete(name);
    }
    setParams(next);
  }
  function setFilters({ from, to, genre, rating: [min, max], region, providers }: Filters) {
    update({
      from, to, genre,
      ratingMin: min > 0 ? String(min) : '',
      ratingMax: max < 10 ? String(max) : '',
      region: region !== 'US' || providers.length ? region : '',
      providers: providers.join(','),
    });
  }
  // The lists of the filter panel load with the page, so the panel opens with them ready. The server keeps them for a
  // day, so the page asks for them again only after that.
  const lists = useQuery<DiscoveryFilters>({ queryKey: ['/discovery/filters'], staleTime: listsTtl });
  const providers = useQuery<WatchProvider[]>({
    queryKey: ['/discovery/providers', filters.region],
    queryFn: () => api<WatchProvider[]>(`/discovery/providers?region=${encodeURIComponent(filters.region)}`),
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
  const sort = sorts.find((option) => option.value === params.get('sort'))?.value ?? 'popularity.desc';
  const request = new URLSearchParams(params);
  request.delete('page');
  request.set('sort', sort);
  if (filters.providers.length) request.set('region', filters.region);
  else request.delete('region');
  const query = `/discovery?${request}`;
  const selection = useSelection();
  useEffect(() => selection.clear(), [query]);
  const { data, error, isFetchingNextPage, fetchNextPage, hasNextPage, refetch } = useInfiniteQuery({
    queryKey: [query],
    queryFn: ({ pageParam }) => api<DiscoveryPage>(`${query}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  const pages = data?.pages ?? [];
  // TMDB repeats a title when the order of a list changes between two pages, so the list keeps the first one.
  const seen = new Set<string>();
  const shown = pages.flatMap((page) => page.rows.flatMap((row) => row.results)).filter((result) => {
    const key = `${result.mediaType}:${result.tmdbId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (term) shown.sort((a, b) => (a.sortKey ?? Infinity) - (b.sortKey ?? Infinity));
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
        <div className="flex flex-wrap items-center gap-4">
          <SubMenu
            aria-label={t('Type')}
            value={type}
            onValueChange={(key) => update({ type: key === 'all' ? '' : key })}
            items={[
              { value: 'all', label: t('All') },
              { value: 'movie', label: t('Movies') },
              { value: 'tv', label: t('Series') },
            ]}
          />
          <Dropdown label={t('Sort by')} hideLabel reserve={false} value={sort} options={sorts} onValueChange={(value) => update({ sort: value === 'popularity.desc' ? '' : value ?? '' })} />
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
      {pages[0]?.needsMatch && <Alert tone="warning">{t('This ID does not match exactly one series. Select the right one.')}</Alert>}
      {error && !shown.length ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : !data || (!shown.length && hasNextPage) ? (
        <div className="grid min-h-96 place-items-center">
          <Spinner size="lg" label={t('Loading')} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState>{t(term ? 'No titles match.' : 'No titles.')}</EmptyState>
      ) : (
        <div className={tiles}>
          <Gallery>
            {shown.map((result) => {
              const key = `${result.mediaType}:${result.tmdbId}`;
              return <ResultItem key={key} result={result} selected={term ? selection.has(key) : undefined} onSelectedChange={term ? () => selection.toggle(key) : undefined} />;
            })}
          </Gallery>
        </div>
      )}
      {hasNextPage && <div ref={more} aria-hidden="true" className="h-px" />}
    </div>
  );
}
