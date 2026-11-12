import type { SearchResult } from '@ladarr/shared/types';
import { Button, Thumbnail, alert } from 'nebula';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { api, ApiError } from '../../lib/api.ts';
import { catalogPath, contentType, posterUrl, describeError } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { useQueueNotice } from '../../lib/queue-notice.ts';

// The button searches the title. A title that is not in the catalog is added first, with the defaults of Settings, as the title page does.
function SearchButton({ result }: { result: SearchResult }) {
  const [libraryKey, setLibraryKey] = useState(result.libraryKey ?? null);
  const [pending, setPending] = useState(false);
  const queueNotice = useQueueNotice();

  async function search() {
    setPending(true);
    try {
      if (libraryKey) {
        const { started } = await api<{ started: string[] }>('/queue/search', { method: 'POST', body: { titleKey: libraryKey } });
        if (!started.length) throw new ApiError(409, 'nothing_to_search');
        queueNotice(started.length);
      } else {
        const summary = { title: result.title, year: result.year, posterPath: result.posterPath };
        const { title } = await api<{ title: { key: string } }>('/library', { method: 'POST', body: { mediaType: result.mediaType, tmdbId: result.tmdbId, add: 'all', summary } });
        setLibraryKey(title.key);
        queueNotice(1);
      }
    } catch (err) {
      alert.danger(t('The request did not complete.'), describeError(err), { timeout: 0 });
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      pending={pending}
      onClick={(event) => {
        // The button is in the link of the poster, and it does its own work.
        event.preventDefault();
        event.stopPropagation();
        void search();
      }}
    >
      {t('Add')}
    </Button>
  );
}

// The poster opens the page of the title, in the catalog or not. With onSelectedChange, the poster can also be selected.
// The caption under the poster says whether the catalog has the title.
export function ResultItem({ result, size, selected, onSelectedChange }: { result: SearchResult; size?: 'sm' | 'md'; selected?: boolean; onSelectedChange?: (selected: boolean) => void }) {
  // A series in the library is anime only when its type says so. A title that is not in the library is a series.
  const type = contentType(result.mediaType, result.seriesType);
  return (
    <RouterLink to={catalogPath(`${result.mediaType}:${result.tmdbId}`)}>
      <Thumbnail
        size={size}
        image={posterUrl(result.posterPath, 'w342') ?? ''}
        title={result.title}
        status={t(result.libraryKey ? 'In catalog' : 'Available')}
        type={type}
        selected={selected}
        onSelectedChange={onSelectedChange}
        overlay={<SearchButton result={result} />}
      />
    </RouterLink>
  );
}
