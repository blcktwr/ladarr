import type { CalendarEvent, CalendarResponse } from '@ladarr/shared/types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Actions, Badge, Button, EmptyState, Field, List, Pane, Row, Section, Spinner, SubMenu, Switch } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { api } from '../../lib/api.ts';
import { Confirm, Link, LoadFailed } from '../../components/index.ts';
import { availabilityLabel, catalogPath } from '../../lib/format.ts';
import { useLive } from '../../lib/live.ts';
import { getLanguage, t } from '../../i18n/index.ts';

type TypeFilter = 'all' | 'movie' | 'tv';

const tone = { waiting: 'neutral', missing: 'warning', available: 'success' } as const;

// The first day of the month that is `shift` months from the given day.
function monthStart(day: string, shift: number) {
  const [year, month] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 + shift, 1)).toISOString().slice(0, 10);
}

function monthEnd(start: string) {
  const [year, month] = start.split('-').map(Number);
  return new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
}

// A day is a date with no time zone. UTC keeps the browser from moving it.
const formatDay = (day: string, options: Intl.DateTimeFormatOptions) => new Date(`${day}T00:00:00Z`).toLocaleDateString(getLanguage(), { ...options, timeZone: 'UTC' });

const episodeCode = (event: CalendarEvent) => `S${String(event.season).padStart(2, '0')}E${String(event.number).padStart(2, '0')}`;

function Status({ event }: { event: CalendarEvent }) {
  const label = !event.monitored ? t('Not monitored') : event.availability === 'waiting' && event.mediaType === 'tv' ? t('Not aired') : availabilityLabel[event.availability];
  return (
    <>
      <Badge tone={event.monitored ? tone[event.availability] : 'neutral'}>{label}</Badge>
      {event.paused && <Badge>{t('Paused')}</Badge>}
    </>
  );
}

function Events({ data }: { data: CalendarResponse }) {
  const time = (event: CalendarEvent) => (event.at === null ? '' : ` ${new Date(event.at).toLocaleTimeString(getLanguage(), { timeZone: data.timeZone, hour: '2-digit', minute: '2-digit' })}`);
  if (data.events.length === 0) return <EmptyState>{t('Nothing is scheduled.')}</EmptyState>;
  return (
    <List>
      {data.events.map((event) => (
        <Row key={event.id}>
          <span>
            {formatDay(event.day, { weekday: 'short', day: 'numeric', month: 'short' })}
            {time(event)}
            {event.day === data.today ? ` (${t('today')})` : ''}
          </span>
          <Link href={catalogPath(event.titleKey)}>{event.title}</Link>
          <span>{event.season === null ? t('Movie') : `${episodeCode(event)} ${event.episodeName ?? ''}`}</span>
          <Status event={event} />
        </Row>
      ))}
    </List>
  );
}

function NoDate({ data }: { data: CalendarResponse }) {
  return (
    <Section title={t('No date')}>
      <List>
        {data.undated.map((item) => (
          <Row key={item.titleKey}>
            <Link href={catalogPath(item.titleKey)}>{item.title}</Link>
            <span>{item.mediaType === 'movie' ? t('Movie') : item.count === 1 ? t('1 episode') : t('{count} episodes', { count: item.count })}</span>
          </Row>
        ))}
      </List>
    </Section>
  );
}

function Feed() {
  const { data, error, isFetching: loading, refetch: reload } = useQuery<{ token: string | null }>({ queryKey: ['/calendar/feed'] });
  const [failed, setFailed] = useState(false);
  // The URL base is part of the base URL of the page.
  const url = data?.token ? new URL(`api/calendar/feed.ics?token=${data.token}`, document.baseURI).href : '';

  async function change(method: 'POST' | 'DELETE') {
    setFailed(false);
    try {
      await api('/calendar/feed', { method, ...(method === 'POST' ? { body: {} } : {}) });
      await reload();
    } catch {
      setFailed(true);
    }
  }

  return (
    <Section
      title={t('iCal feed')}
      actions={
        <>
          {data && !data.token && <Button onClick={() => void change('POST')}>{t('Create feed')}</Button>}
          {data?.token && typeof navigator.clipboard !== 'undefined' && (
            <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(url)}>
              {t('Copy')}
            </Button>
          )}
          {data?.token && (
            <Confirm label={t('New URL')} title={t('Make a new feed URL?')} confirm={t('New URL')} onConfirm={() => void change('POST')}>
              {t('The old URL stops working at once. Update every app that uses it.')}
            </Confirm>
          )}
          {data?.token && (
            <Confirm label={t('Turn off')} title={t('Turn off the feed?')} confirm={t('Turn off')} onConfirm={() => void change('DELETE')}>
              {t('The URL stops working at once.')}
            </Confirm>
          )}
        </>
      }
    >
      {error && !data ? (
        <LoadFailed onRetry={reload} />
      ) : loading && !data ? (
        <Spinner label={t('Loading')} />
      ) : (
        url && <Field label={t('Feed URL')} hideLabel width="full" readOnly value={url} />
      )}
      {failed && <Alert tone="danger">{t('The request did not complete.')}</Alert>}
    </Section>
  );
}

export function Calendar() {
  const [type, setType] = useState<TypeFilter>('all');
  const [unmonitored, setUnmonitored] = useState(false);
  // The first day of the month on show. Null is the month of today, and the server finds it.
  const [start, setStart] = useState<string | null>(null);
  const params = new URLSearchParams();
  if (start) {
    params.set('from', start);
    params.set('to', monthEnd(start));
  }
  if (type !== 'all') params.set('type', type);
  if (unmonitored) params.set('monitored', '0');
  const { data, error, isFetching: loading, refetch: reload } = useQuery<CalendarResponse>({ queryKey: [`/calendar?${params}`], placeholderData: keepPreviousData });
  useLive('library.changed', () => void reload());

  if (error && !data) return <Pane><LoadFailed onRetry={reload} /></Pane>;
  if (!data) return <Spinner label={t('Loading')} />;

  return (
    <Pane>
      <Section title={formatDay(data.from, { month: 'long', year: 'numeric' })}>
        <SubMenu
          aria-label={t('Type')}
          value={type}
          onValueChange={(value) => setType(value as TypeFilter)}
          items={[
            { value: 'all', label: t('All') },
            { value: 'movie', label: t('Movies') },
            { value: 'tv', label: t('Series') },
          ]}
        />
        <Switch label={t('Show unmonitored')} checked={unmonitored} onCheckedChange={setUnmonitored} />
        <Actions>
          <Button variant="ghost" aria-label={t('Previous month')} onClick={() => setStart(monthStart(start ?? data.from, -1))}>
            {t('Previous')}
          </Button>
          <Button variant="ghost" onClick={() => setStart(null)}>
            {t('Today')}
          </Button>
          <Button variant="ghost" aria-label={t('Next month')} onClick={() => setStart(monthStart(start ?? data.from, 1))}>
            {t('Next')}
          </Button>
          {loading && <Spinner label={t('Loading')} />}
        </Actions>
        {error && <LoadFailed onRetry={reload} />}
        {data.truncated && <Alert tone="warning">{t('The list is not complete. Select Movies or Series to see less.')}</Alert>}
        <Events data={data} />
      </Section>
      {data.undated.length > 0 && <NoDate data={data} />}
      <Feed />
    </Pane>
  );
}
