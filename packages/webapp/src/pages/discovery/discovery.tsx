import type { DiscoveryPage, DiscoverySort } from '@ladarr/shared/types';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Dropdown, EmptyState, Gallery, Text } from 'nebula';
import { useEffect, useRef, useState } from 'react';
import { LoadFailed, LoadingGallery } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { t } from '../../i18n/index.ts';
import { ResultItem } from '../search/result-item.tsx';

// The page has the margins of the app, as the catalog does.
const page = 'grid gap-8 p-6';
// The title has a centered column, and its content aligns at its left edge.
const column = 'mx-auto w-[min(1200px,calc(100%-40px))]';
// The rows span the window. The column is as wide as the columns of thumbnails that fit in it, so the room that a
// column does not fill goes in equal parts to each side (10rem per thumbnail and 1.5rem between them).
const tiles = 'mx-auto w-[calc(round(down,calc(100%+1.5rem),11.5rem)-1.5rem)]';

// The titles of TMDB that the catalog does not have yet. A poster opens the title page, and its button adds it.
export function Discovery() {
  const [sort, setSort] = useState<DiscoverySort>('popularity.desc');
  const { data, error, isFetchingNextPage, fetchNextPage, hasNextPage, refetch } = useInfiniteQuery({
    queryKey: ['/discovery', sort],
    queryFn: ({ pageParam }) => api<DiscoveryPage>(`/discovery?page=${pageParam}&sort=${sort}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  const sorts: { value: DiscoverySort; label: string }[] = [
    { value: 'popularity.asc', label: t('Popularity (asc)') },
    { value: 'popularity.desc', label: t('Popularity (desc)') },
    { value: 'release.asc', label: t('Release date (asc)') },
    { value: 'release.desc', label: t('Release date (desc)') },
    { value: 'rating.asc', label: t('TMDB rating (asc)') },
    { value: 'rating.desc', label: t('TMDB rating (desc)') },
  ];
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
        <Dropdown value={sort} options={sorts} onValueChange={(value) => setSort((value ?? 'popularity.desc') as DiscoverySort)} />
      </div>
      {error && !data ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : !data ? (
        <div className={tiles}>
          <LoadingGallery />
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
