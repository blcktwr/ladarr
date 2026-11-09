import type { AlertView } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { alert, Button, EmptyState, Pane, Section, Table, useAlerts } from 'nebula';
import { useState } from 'react';
import { Link, LoadFailed, pageWidth } from '../../components/index.ts';
import { t } from '../../i18n/index.ts';

const columns = [
  { label: 'Alert' },
  { label: 'What to do' },
  { label: 'Actions', align: 'end' as const, hideLabel: true },
];

// The page lists every alert that the server holds, also the ones that the person closed as a toast. The server
// collects them, so the list does not depend on the page that is open.
export function Alerts() {
  const { data, error, refetch } = useQuery<{ alerts: AlertView[] }>({ queryKey: ['/alerts'] });
  const { toasts } = useAlerts();
  // The alerts that the person cleared are gone from the list for this visit, also when the server sends them again.
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());
  const alerts = data?.alerts.filter((item) => !cleared.has(item.id));
  const rows = alerts?.map((item) => ({
    key: item.id,
    cells: [
      t(item.title, item.params),
      t(item.message, item.params),
      <Link href="/settings">{t('Open settings')}</Link>,
    ],
  }));

  // The alerts of the list are the same toasts that float over the page, so the button closes them too.
  function clearAll() {
    toasts.forEach((toast) => alert.close(toast.id));
    setCleared((current) => new Set([...current, ...(alerts ?? []).map((item) => item.id)]));
  }

  return (
    <div className={`${pageWidth} grid gap-6`}>
      <Pane className="w-full">
        <Section
          title={t('Alerts')}
          action={
            <Button disabled={!alerts?.length} onClick={clearAll}>
              {t('Clear all')}
            </Button>
          }
        >
          {error && !data ? (
            <LoadFailed onRetry={refetch} />
          ) : alerts && alerts.length === 0 ? (
            <EmptyState>{t('No alerts.')}</EmptyState>
          ) : (
            <Table
              aria-label={t('Alerts')}
              loading={!data}
              columns={columns.map((column) => ({ ...column, label: t(column.label) }))}
              rows={rows}
            />
          )}
        </Section>
      </Pane>
    </div>
  );
}
