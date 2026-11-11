import type { LogEntry, LogsResponse, SettingsResponse } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Copy, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api } from '../../lib/api.ts';
import { Button, Confirm, Dropdown, EmptyState, Field, List, Pagination, Pane, Section, SideMenu, Spinner, Switch, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { t } from '../../i18n/index.ts';
import { LogRow } from '../../lib/log-row.tsx';
import { useAuth } from '../auth/auth.tsx';
import { DownloadClients } from './connections-settings.tsx';
import { Indexers } from './indexer-settings.tsx';
import { NamingSettings } from './import-settings.tsx';
import { FolderSettings, GeneralSettings } from './library-settings.tsx';
import { Qualities } from './quality-settings.tsx';
import { Backups, SystemVersion } from './system-settings.tsx';
import { Webhook } from './webhook-settings.tsx';
import { Help } from './help-settings.tsx';

function ApiKey() {
  const { data, error, isFetching: loading, refetch: reload } = useQuery<{ apiKey: string }>({ queryKey: ['/auth/api-key'] });
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [rotating, setRotating] = useState(false);

  async function rotate() {
    setFailed(false);
    setRotating(true);
    try {
      await api('/auth/api-key/rotate', { method: 'POST', body: {} });
      await reload();
    } catch {
      setFailed(true);
    } finally {
      setRotating(false);
      setAsking(false);
    }
  }

  return (
    <>
      {error && !data ? (
        <LoadFailed onRetry={reload} />
      ) : loading && !data ? (
        <Spinner label={t('Loading')} />
      ) : (
        <Field
          label={t('API key')}
          readOnly
          width="full"
          value={data?.apiKey ?? ''}
          action={
            <>
              {typeof navigator.clipboard !== 'undefined' && (
                <Button variant="ghost" iconOnly aria-label={t('Copy')} disabled={!data} onClick={() => void navigator.clipboard.writeText(data!.apiKey)}>
                  <Copy />
                </Button>
              )}
              <Button variant="ghost" iconOnly aria-label={t('Rotate key')} disabled={!data} onClick={() => setAsking(true)}>
                <RotateCw />
              </Button>
            </>
          }
        />
      )}
      {failed && <Alert tone="danger">{t('The request did not complete.')}</Alert>}
      <Confirm open={asking} onOpenChange={(open) => !rotating && setAsking(open)} title={t('Rotate the API key?')} confirm={t('Rotate key')} pending={rotating} onConfirm={() => void rotate()}>
        {t('The old key stops working at once. Update every app that uses it.')}
      </Confirm>
    </>
  );
}

const levelLook = {
  info: { label: 'Info' },
  warn: { label: 'Warning' },
  error: { label: 'Error' },
} as const;

type Period = 'all' | 'hour' | 'day' | 'week';
const periods: { value: Period; label: string; ms?: number }[] = [
  { value: 'all', label: 'All time' },
  { value: 'hour', label: 'Last hour', ms: 60 * 60_000 },
  { value: 'day', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { value: 'week', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
];

// The day of the log entry in the local time zone, to compare with the date field.
const localDay = (time: string) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

type Traffic = '' | 'inbound' | 'outbound';
// Only a request has a direction. A log has none.
const directionOf = (entry: LogEntry): Traffic => (entry.direction === 'inbound' || entry.direction === 'outbound' ? entry.direction : '');

// The entries on a page. The server sends up to 1000 entries at once, the filters act on all of them, and a page
// shows 100.
const PAGE = 100;

// The setting of the log of a target in the queue. The change is saved at once.
function QueueLogs() {
  const { data, refetch } = useQuery<SettingsResponse>({ queryKey: ['/settings'] });
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  async function save(keep: boolean) {
    setFailed(false);
    setPending(true);
    try {
      await api('/settings', { method: 'PATCH', body: { keepQueueLogs: keep } });
      await refetch();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  if (!data) return null;
  return (
    <>
      <Switch label={t('Keep the full log of every target in the queue')} checked={data.settings.keepQueueLogs} disabled={pending} onCheckedChange={(keep) => void save(keep)} />
      {failed && <Alert tone="danger">{t('The request did not complete.')}</Alert>}
    </>
  );
}

function LogEntries({ kind }: { kind: 'logs' | 'requests' }) {
  const [live, setLive] = useState(false);
  const { data, error, isFetching: loading, refetch: reload } = useQuery<LogsResponse>({ queryKey: [`/system/logs?limit=1000&kind=${kind}`], refetchInterval: live ? 2_000 : false });
  const [period, setPeriod] = useState<Period>('all');
  const [date, setDate] = useState('');
  const [level, setLevel] = useState('');
  const [type, setType] = useState<'' | 'system' | 'catalog'>('');
  const [traffic, setTraffic] = useState<Traffic>('');
  const [page, setPage] = useState(0);
  const now = Date.now();
  const window = periods.find((item) => item.value === period)?.ms;
  // The server returns the entries of one file, so the page filters them here. The newest comes first.
  const rows = [...(data?.entries ?? [])]
    .reverse()
    .filter((entry) => (!type || (entry.type ?? 'system') === type) && (!level || entry.level === level) && (!traffic || directionOf(entry) === traffic) && (!window || Date.parse(entry.time) >= now - window) && (!date || localDay(entry.time) === date));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * PAGE, (current + 1) * PAGE);
  // A new filter starts again at the first page.
  const filter = (change: () => void) => {
    change();
    setPage(0);
  };

  return (
    <Section title={t(kind === 'requests' ? 'Requests' : 'Logs')}>
      {error && !data ? (
        <LoadFailed onRetry={reload} />
      ) : (
        <>
          {kind === 'logs' && <QueueLogs />}
          <div className="flex flex-wrap items-center gap-4 w-full">
            {kind === 'logs' && (
              <>
                <Dropdown
                  label={t('Level')}
                  value={level}
                  options={[{ value: '', label: t('All') }, ...Object.entries(levelLook).map(([value, look]) => ({ value, label: t(look.label) }))]}
                  onValueChange={(value) => filter(() => setLevel(value ?? ''))}
                />
                <Dropdown
                  label={t('Type')}
                  value={type}
                  options={[{ value: '', label: t('All') }, { value: 'system', label: t('System') }, { value: 'catalog', label: t('Catalog') }]}
                  onValueChange={(value) => filter(() => setType((value ?? '') as '' | 'system' | 'catalog'))}
                />
              </>
            )}
            {kind === 'requests' && (
              <Dropdown
                label={t('Traffic')}
                value={traffic}
                options={[{ value: '', label: t('All') }, { value: 'inbound', label: t('Inbound') }, { value: 'outbound', label: t('Outbound') }]}
                onValueChange={(value) => filter(() => setTraffic((value ?? '') as Traffic))}
              />
            )}
            <Dropdown label={t('Time')} value={period} options={periods.map((item) => ({ value: item.value, label: t(item.label) }))} onValueChange={(value) => filter(() => setPeriod(value as Period))} />
            <Field label={t('Date')} type="date" width="sm" value={date} onValueChange={(value) => filter(() => setDate(value))} />
            <Switch label={t('Live')} checked={live} onCheckedChange={setLive} />
          </div>
          {loading && !data && <Spinner label={t('Loading')} />}
          {!loading && rows.length === 0 && <EmptyState>{t('No log entries.')}</EmptyState>}
          <List>
            {shown.map((entry) => (
              <LogRow key={`${entry.time}|${entry.message}`} entry={entry} kind={kind} />
            ))}
          </List>
          {pages > 1 && <Pagination aria-label={t('Pages')} page={current + 1} count={pages} onPageChange={(next) => setPage(next - 1)} />}
        </>
      )}
    </Section>
  );
}

const categories = [
  {
    value: 'general',
    label: 'General',
    content: (
      <>
        <Pane>
          <div className="grid grid-cols-[minmax(0,1fr)] justify-items-start gap-4 w-full">
            <GeneralSettings />
            <ApiKey />
          </div>
        </Pane>
        <Pane>
          <SystemVersion />
        </Pane>
      </>
    ),
  },
  {
    value: 'media',
    label: 'Media',
    content: (
      <>
        <Pane>
          <FolderSettings />
        </Pane>
        <Pane>
          <NamingSettings />
        </Pane>
      </>
    ),
  },
  {
    value: 'quality',
    label: 'Quality',
    content: (
      <>
        <Pane>
          <Qualities />
        </Pane>
      </>
    ),
  },
  {
    value: 'connections',
    label: 'Connections',
    content: (
      <>
        <Pane>
          <Indexers />
        </Pane>
        <Pane>
          <DownloadClients />
        </Pane>
        <Pane>
          <Webhook />
        </Pane>
      </>
    ),
  },
  {
    value: 'logs',
    label: 'Logs',
    content: (
      <Pane>
        <LogEntries kind="logs" />
      </Pane>
    ),
  },
  {
    value: 'requests',
    label: 'Requests',
    content: (
      <Pane>
        <LogEntries kind="requests" />
      </Pane>
    ),
  },
  {
    value: 'backups',
    label: 'Backups',
    content: (
      <Pane>
        <Backups />
      </Pane>
    ),
  },
  {
    value: 'help',
    label: 'Help',
    content: (
      <Pane>
        <Help />
      </Pane>
    ),
  },
];

export function Settings() {
  const { logout } = useAuth();
  const { hash } = useLocation();
  const navigate = useNavigate();
  // The hash names the section, so a link can open a section of the settings.
  const category = categories.find((item) => `#${item.value}` === hash)?.value ?? 'general';
  const active = categories.find((item) => item.value === category)!;
  const setCategory = (value: string) => void navigate(`/settings#${value}`, { replace: true });
  // The side space is the one of the Navbar: its content column is 1200px wide and centred.
  return (
    <div className="mt-6 pb-6 px-[max(20px,(100cqw_-_1200px)_/_2)] grid items-start gap-6 sm:grid-cols-[max-content_minmax(0,1fr)]">
      <div className="flex flex-col items-start gap-3">
        <SideMenu aria-label={t('Settings')} value={category} onValueChange={setCategory} items={categories.map(({ value, label }) => ({ value, label: t(label) }))} />
        <Button variant="ghost-danger" onClick={() => void logout()}>
          {t('Sign out')}
        </Button>
      </div>
      <div className="grid gap-4">
        <Text variant="title">{t(active.label)}</Text>
        {active.content}
      </div>
    </div>
  );
}
