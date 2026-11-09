import type { QueueJob } from '@ladarr/shared/types';
import ReactJsonView from '@microlink/react-json-view';
import { useQuery } from '@tanstack/react-query';
import { ListClock, Play, X } from 'lucide-react';
import { Button, EmptyState, Panel, Spinner, Table, Text, Thumbnail } from 'nebula';
import { useState } from 'react';
import { LoadFailed } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { getLanguage, t } from '../../i18n/index.ts';
import { posterUrl } from '../../lib/format.ts';
import { jobName } from '../../lib/job.ts';
import { useLive } from '../../lib/live.ts';

const stampOf = (time: number) => {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
};

// The time from now as a short text, such as "2h". The formatter is narrow, so it stays on one line.
const fromNow = (time: number) => {
  const format = (value: number, unit: 'minute' | 'hour' | 'day') =>
    new Intl.NumberFormat(getLanguage(), { style: 'unit', unitDisplay: 'narrow', unit }).format(value);
  const minutes = Math.max(1, Math.ceil((time - Date.now()) / 60_000));
  if (minutes < 60) return format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format(hours, 'hour');
  return format(Math.round(hours / 24), 'day');
};

// A running job is the current work of the page, so it has no start time to show.
const timeOf = (job: QueueJob) => {
  if (job.state === 'running') return t('Running now');
  if (job.eta <= Date.now() + 1_000) return t('Runs now');
  return t('Will run at {time} ({relative})', { time: stampOf(job.eta), relative: fromNow(job.eta) });
};

// The jobs of the item flow that run now or wait for the worker. A click on a row shows the payload of the job.
export function JobsPanel() {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const { data, error, isFetching, refetch } = useQuery<{ items: QueueJob[] }>({
    queryKey: ['/queue/jobs'],
    enabled: open,
    gcTime: 0,
    refetchInterval: open ? 2_000 : false,
  });
  const theme = document.documentElement.dataset.theme === 'light' ? 'rjv-default' : 'monokai';
  // The queue announces each change of a target. The panel follows the current job at the same moment.
  useLive('queue.changed', () => {
    if (open) void refetch();
  });

  async function act(path: string, method: 'POST' | 'DELETE') {
    try {
      await api(path, { method });
    } catch {
      // The next load shows the state of the job.
    }
    await refetch();
  }

  // The next job that the worker starts: the first one that waits. Only it can run now.
  const next = data?.items.find((job) => job.state !== 'running')?.id ?? null;

  return (
    <Panel
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDetail(null);
      }}
      label={t('Jobs in the queue')}
      title={t('Jobs in the queue')}
      size="lg"
      trigger={
        <Button iconOnly aria-label={t('Jobs in the queue')}>
          <ListClock />
        </Button>
      }
    >
      {error && !data ? (
        <LoadFailed onRetry={refetch} />
      ) : isFetching && !data ? (
        <Spinner label={t('Loading')} />
      ) : !data?.items.length ? (
        <EmptyState>{t('No job is in the queue.')}</EmptyState>
      ) : (
        <div className="min-w-0 overflow-x-hidden">
          <Table
            aria-label={t('Jobs in the queue')}
            columns={[
              { label: t('Job'), hideLabel: true },
              { label: t('Actions'), hideLabel: true, align: 'end' },
            ]}
            rows={data.items.map((job) => {
              const name = jobName(job);
              return {
                key: job.id,
                onClick: () => setDetail((current) => (current === job.id ? null : job.id)),
                detail:
                  detail === job.id ? (
                    <div className="overflow-x-auto">
                      <ReactJsonView src={job.payload as object} name={false} collapsed={1} displayDataTypes={false} displayObjectSize={false} enableClipboard={false} indentWidth={2} theme={theme} />
                    </div>
                  ) : undefined,
                cells: [
                  <div key="job" className="flex items-center gap-3 min-w-0">
                    {/* The name says the title and the job, so the poster has no text. Its empty caption is cut off, so it takes no height. */}
                    <div className="shrink-0 h-30 overflow-hidden">
                      <Thumbnail size="xs" image={posterUrl(job.posterPath) ?? ''} title="" year="" />
                    </div>
                    <div className="grid gap-1 min-w-0">
                      <Text>
                        <strong>{name}</strong>
                      </Text>
                      <Text variant="small">{timeOf(job)}</Text>
                    </div>
                  </div>,
                  <div key="actions" className="flex items-center justify-end gap-1">
                    {job.id === next && (
                      <Button variant="ghost" iconOnly aria-label={t('Run {name} now', { name })} onClick={() => void act(`/queue/jobs/${job.id}/run`, 'POST')}>
                        <Play />
                      </Button>
                    )}
                    <Button variant="ghost" iconOnly aria-label={t('Remove {name} from the queue', { name })} disabled={job.state === 'running'} onClick={() => void act(`/queue/jobs/${job.id}`, 'DELETE')}>
                      <X />
                    </Button>
                  </div>,
                ],
              };
            })}
          />
        </div>
      )}
    </Panel>
  );
}
