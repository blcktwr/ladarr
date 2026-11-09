import type { SearchResult } from '@ladarr/shared/types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { EmptyState, Gallery, Pane } from 'nebula';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed, LoadingGallery } from '../../components/index.ts';
import { useSelection } from '../library/library-bulk.tsx';
import { ResultItem } from './result-item.tsx';
import { t } from '../../i18n/index.ts';

export function SearchPage() {
  const [params] = useSearchParams();
  const query = params.get('q')?.trim() ?? '';
  const selection = useSelection();
  const { data, error, isFetching: loading, refetch: reload } = useQuery<{ results: SearchResult[]; needsMatch?: boolean }>({ queryKey: [`/search?query=${encodeURIComponent(query)}`], placeholderData: keepPreviousData });
  // A new search shows other titles, so the old selection ends.
  useEffect(() => selection.clear(), [query]);

  if (!query) return <Pane><EmptyState>{t('Type a title in the search box.')}</EmptyState></Pane>;
  if (error && !data) return <Pane><LoadFailed onRetry={reload} /></Pane>;
  if (loading && !data) return <div className="p-6"><LoadingGallery /></div>;

  return (
    <div className="p-6">
      {data?.needsMatch && <Alert tone="warning">{t('This ID does not match exactly one series. Select the right one.')}</Alert>}
      {data?.results.length === 0 && <EmptyState>{t('No titles match.')}</EmptyState>}
      <Gallery>
        {data?.results.map((result) => {
          const key = `${result.mediaType}:${result.tmdbId}`;
          return <ResultItem key={key} result={result} selected={selection.has(key)} onSelectedChange={() => selection.toggle(key)} />;
        })}
      </Gallery>
    </div>
  );
}
