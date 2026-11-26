import type { QueueEntryView } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { Button, EmptyState, Panel, Spinner, Table, Text, Thumbnail } from 'nebula';
import { useState } from 'react';
import { LoadFailed } from '../../components/index.ts';
import { t } from '../../i18n/index.ts';
import { posterUrl } from '../../lib/format.ts';
import { useLive } from '../../lib/live.ts';

// The targets that ladarr finished, the newest first. The list of the page holds the work that is not done, so the
// finished ones have a panel of their own.
export function FinishedPanel() {
  const [open, setOpen] = useState(false);
  const { data, error, refetch } = useQuery<{ total: number; items: QueueEntryView[] }>({
    queryKey: ['/queue/recent'],
    enabled: open,
    gcTime: 0,
  });
  useLive('queue.changed', () => {
    if (open) void refetch();
  });

  return (
    <Panel open={open} onOpenChange={setOpen} label={t('Completed')} title={t('Finished')} size="lg" trigger={<Button variant="ghost"><CircleCheck />{t('Completed')}</Button>}>
      {error && !data ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : !data ? (
        <Spinner label={t('Loading')} />
      ) : !data.items.length ? (
        <EmptyState>{t('Nothing has finished yet.')}</EmptyState>
      ) : (
        <div className="min-w-0 overflow-x-hidden">
          <Table
            aria-label={t('Finished')}
            animated
            columns={[{ label: t('Title'), hideLabel: true }]}
            rows={data.items.map((entry) => ({
              key: entry.id,
              cells: [
                <div key="title" className="flex items-center gap-3 min-w-0">
                  {/* The name says the title, so the poster has no text. Its empty caption is cut off, so it takes no height. */}
                  <div className="shrink-0 h-30 overflow-hidden">
                    <Thumbnail size="xs" image={posterUrl(entry.posterPath) ?? ''} title="" year="" />
                  </div>
                  <div className="grid gap-1 min-w-0">
                    <Text>
                      <strong>{entry.label}</strong>
                    </Text>
                  </div>
                </div>,
              ],
            }))}
          />
        </div>
      )}
    </Panel>
  );
}
