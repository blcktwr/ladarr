import type { LogEntry, LogsResponse } from '@ladarr/shared/types';
import ReactJsonView from '@microlink/react-json-view';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Panel, Row, Spinner, Text } from 'nebula';
import { useState } from 'react';
import { LoadFailed } from '../components/load-failed.tsx';
import { getLanguage, t } from '../i18n/index.ts';
import { api } from './api.ts';
import { linkedRequests } from './log-links.ts';
import { xmlToJson } from './xml.ts';

// A body that holds JSON text shows as JSON, so the whole payload is easy to read.
const payloadView = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return payload ?? {};
  const body = (payload as { body?: unknown }).body;
  if (typeof body !== 'string') return payload;
  try {
    return { ...payload, body: JSON.parse(body) };
  } catch {
    // An XML body shows as a tree, in the same way.
    const xml = body.trimStart().startsWith('<') ? xmlToJson(body) : undefined;
    return xml === undefined ? payload : { ...payload, body: xml };
  }
};

const objectOf = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined);

// A long line stops at the right edge with a fade, so the row keeps one line.
const fade = 'min-w-0 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%_-_3rem),transparent)]';

const stampOf = (entry: LogEntry) => {
  const date = new Date(entry.time);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(getLanguage());
};

// The code of the answer, as a badge. A request that never got an answer shows as failed.
const statusOf = (entry: LogEntry) => {
  const response = objectOf(entry.response);
  const status = typeof response?.status === 'number' ? response.status : typeof entry.status === 'number' ? entry.status : undefined;
  if (status !== undefined) {
    const tone: 'danger' | 'warning' | 'neutral' | 'success' = status >= 500 ? 'danger' : status >= 400 ? 'warning' : status >= 300 ? 'neutral' : 'success';
    return { label: String(status), tone };
  }
  return typeof entry.code === 'string' ? { label: t('Failed'), tone: 'danger' as const } : null;
};

// The main line of a request: the method and the address. A log shows its message.
const titleOf = (entry: LogEntry, kind: 'logs' | 'requests') => {
  if (kind === 'logs') return entry.message;
  const request = objectOf(entry.request);
  const method = typeof request?.method === 'string' ? request.method : typeof entry.method === 'string' ? entry.method : '';
  const url = typeof request?.url === 'string' ? request.url : typeof entry.path === 'string' ? entry.path : '';
  return [method, url].filter(Boolean).join(' ') || entry.message;
};

// The request and the answer as trees, so the whole payload of a request is easy to read.
function RequestDetails({ entry }: { entry: LogEntry }) {
  const theme = document.documentElement.dataset.theme === 'light' ? 'rjv-default' : 'monokai';
  const tree = (value: unknown) => (
    <ReactJsonView src={payloadView(value) as object} name={false} collapsed={1} displayDataTypes={false} displayObjectSize={false} enableClipboard={false} indentWidth={2} theme={theme} />
  );
  const request = objectOf(entry.request) ?? (entry.method || entry.path ? { method: entry.method, url: entry.path } : undefined);
  const response = objectOf(entry.response) ?? (entry.status !== undefined ? { status: entry.status } : undefined);
  if (!request && !response) return <LogDetails entry={entry} />;
  return (
    <div className="grid gap-6 min-w-0">
      <div className="grid gap-2 min-w-0">
        <strong>{t('Request')}</strong>
        <div className="overflow-x-auto">{tree(request)}</div>
      </div>
      <div className="grid gap-2 min-w-0">
        <strong>{t('Response')}</strong>
        <div className="overflow-x-auto">{tree(response)}</div>
      </div>
    </div>
  );
}

// The requests that share an id or a label with the entry. They open in a panel of their own, above the panel of the
// entry. A series sends several queries to the same indexer, and they share one button.
function LinkedRequest({ ids, label }: { ids: string[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const { data, error, isFetching, refetch } = useQuery<LogsResponse>({
    queryKey: [`/system/logs?limit=1000&kind=requests&requestIds=${ids.map(encodeURIComponent).join(',')}`],
    enabled: open,
    queryFn: async () => {
      const pages = await Promise.all(ids.map((id) => api<LogsResponse>(`/system/logs?limit=1000&kind=requests&requestId=${encodeURIComponent(id)}`)));
      return { entries: pages.flatMap((page) => page.entries) };
    },
  });
  const name = label ?? t('Request {id}', { id: ids[0] });
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t('View request / response')}
      </Button>
      <Panel open={open} onOpenChange={setOpen} label={name} title={name} size="md">
        <div className="grid gap-6 min-w-0">
          {error && !data ? (
            <LoadFailed onRetry={refetch} />
          ) : isFetching && !data ? (
            <Spinner label={t('Loading')} />
          ) : !data?.entries.length ? (
            <EmptyState>{t('No request entries.')}</EmptyState>
          ) : (
            data.entries.map((entry) => (
              <div key={`${entry.time}|${entry.message}`} className="grid gap-3 min-w-0">
                <RequestDetails entry={entry} />
              </div>
            ))
          )}
        </div>
      </Panel>
    </>
  );
}

// The whole entry as a tree, so the request, the answer and the other fields show in one place.
function LogDetails({ entry }: { entry: LogEntry }) {
  const theme = document.documentElement.dataset.theme === 'light' ? 'rjv-default' : 'monokai';
  // A body that holds JSON text shows as JSON, in the request and in the answer.
  const view = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, value && typeof value === 'object' ? payloadView(value) : value]));
  return (
    <div className="grid gap-4 min-w-0">
      <div className="overflow-x-auto">
        <ReactJsonView src={view as object} name={false} collapsed={1} displayDataTypes={false} displayObjectSize={false} enableClipboard={false} indentWidth={2} theme={theme} />
      </div>
      {linkedRequests(entry).map(({ ids, label }) => (
        <LinkedRequest key={ids.join(',')} ids={ids} {...(label ? { label } : {})} />
      ))}
    </div>
  );
}

// One entry of the log: the time, and the line itself. A long line is cut with a fade, and a click on it shows the
// whole entry. A request also shows the code of its answer.
export function LogRow({ entry, kind = 'logs' }: { entry: LogEntry; kind?: 'logs' | 'requests' }) {
  const status = kind === 'requests' ? statusOf(entry) : null;
  return (
    <Row>
      <div className={`grid ${kind === 'requests' ? 'grid-cols-[10.5rem_5rem_minmax(0,1fr)]' : 'grid-cols-[10.5rem_minmax(0,1fr)]'} items-center gap-x-3 w-[100rem] max-w-full`}>
        <Text variant="small">{stampOf(entry)}</Text>
        {kind === 'requests' && <div>{status && <Badge tone={status.tone}>{status.label}</Badge>}</div>}
        <div className={fade}>
          <Panel label={t('Details of {message}', { message: entry.message })} trigger={<Button variant="plain">{titleOf(entry, kind)}</Button>} size="lg">
            <div className="grid gap-4 min-h-0 overflow-y-auto">{kind === 'requests' ? <RequestDetails entry={entry} /> : <LogDetails entry={entry} />}</div>
          </Panel>
        </div>
      </div>
    </Row>
  );
}
