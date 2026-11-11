import type { BlocklistRow } from '@ladarr/shared/types';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { Button, EmptyState, Section, Table, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { Confirm } from '../../components/index.ts';
import { describeError } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';

const PAGE = 50;

// The releases of one series that ladarr must not take again.
export function SeriesBlocklist({ titleKey }: { titleKey: string }) {
  const [message, setMessage] = useState('');
  const scope = `titleKey=${encodeURIComponent(titleKey)}`;
  const { data, error, isFetching: loading, refetch, fetchNextPage, hasNextPage } = useInfiniteQuery({
    queryKey: ['/blocklist', titleKey],
    queryFn: ({ pageParam }) => api<{ total: number; items: BlocklistRow[] }>(`/blocklist?${scope}&limit=${PAGE}&offset=${pageParam}`),
    initialPageParam: 0,
    // The next page starts after the rows that the card has.
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const rows = data?.pages.flatMap((page) => page.items);
  const total = data?.pages.at(-1)?.total ?? 0;

  async function remove(row: BlocklistRow) {
    setMessage('');
    try {
      await api(`/blocklist/${row.id}`, { method: 'DELETE' });
      void refetch();
    } catch (err) {
      setMessage(describeError(err));
    }
  }

  async function clear() {
    setMessage('');
    try {
      await api(`/blocklist?${scope}`, { method: 'DELETE' });
      void refetch();
    } catch (err) {
      setMessage(describeError(err));
    }
  }

  return (
    <Section title={t('Blocklist')}
      action={
        total > 0 && (
          <Confirm label={t('Clear the blocklist')} title={t('Clear the blocklist?')} confirm={t('Clear the blocklist')} onConfirm={() => void clear()}>
            {t('Blocked releases can be taken again.')}
          </Confirm>
        )
      }
      actions={
        hasNextPage && (
          <Button variant="ghost" pending={loading} onClick={() => void fetchNextPage()}>
            {t('Show more')}
          </Button>
        )
      }
    >
      {message && <Alert tone="danger">{message}</Alert>}
      {error && !data ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : (
        <>
          {rows?.length === 0 ? (
            <EmptyState>{t('No release is blocked.')}</EmptyState>
          ) : (
            <Table
              aria-label={t('Blocklist')}
              loading={!rows}
              columns={[{ label: t('Title') }, { label: t('Actions'), align: 'end', hideLabel: true }]}
              rows={rows?.map((row) => ({
                key: row.id,
                cells: [
                  <div className="grid gap-1">
                    <span>{row.title}</span>
                    <Text variant="small">{t(row.reason.message)}</Text>
                  </div>,
                  <Button variant="ghost" iconOnly aria-label={t('Delete {title} from the blocklist', { title: row.title })} onClick={() => void remove(row)}>
                    <Trash2 />
                  </Button>,
                ],
              }))}
            />
          )}
        </>
      )}
    </Section>
  );
}
