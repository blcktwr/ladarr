import type { TrackerStatus } from '@ladarr/shared/enums';
import type { QueueClientDetail } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Section, Spinner } from 'nebula';
import { t } from '../../i18n/index.ts';

// The state of a torrent as the client reports it. A check by the client is not the file check of ladarr.
export const clientStatusLabel: Record<QueueClientDetail['status'], string> = {
  metadata: 'The client gets the metadata',
  queued: 'The torrent waits for a slot in the client',
  checking: 'The client checks the files',
  moving: 'The client moves the files',
  downloading: 'The client downloads',
  stalled: 'The client downloads, but no data arrives',
  paused: 'The torrent is stopped in the client',
  complete: 'The torrent is complete and stopped',
  seeding: 'The client seeds',
  error: 'The client reports an error',
  unknown: 'The client reports an unknown state',
};

const trackerLabel: Record<TrackerStatus, string> = {
  disabled: 'off',
  not_contacted: 'not contacted yet',
  working: 'working',
  updating: 'updating',
  not_working: 'not working',
  unknown: 'unknown',
};

const count = (value: number | null, one: string, many: string) => (value === null ? t('unknown') : value === 1 ? t(one) : t(many, { n: value }));

// What the client reports about the torrent. It reads the client once, when the details open. A value that the client does not report is unknown.
export function ClientDetails({ entryId }: { entryId: string }) {
  const { data, error } = useQuery<{ detail: QueueClientDetail }>({ queryKey: [`/queue/entries/${entryId}/client`] });
  const detail = data?.detail;

  if (error) {
    return <p>{error.message === 'torrent_not_found' ? t('The client does not have this torrent.') : error.message === 'client_unreachable' ? t('The client does not answer.') : t('The request did not complete.')}</p>;
  }
  if (!detail) return <Spinner label={t('Loading client details')} size="sm" />;
  const { slots } = detail;
  return (
    <Section title={t('Download client')}>
      <p>{t(clientStatusLabel[detail.status])}.</p>
      <p>
        {t('Swarm: {seeds}, {peers}.', { seeds: count(detail.swarm.seeds, '1 seed', '{n} seeds'), peers: count(detail.swarm.peers, '1 peer', '{n} peers') })}
      </p>
      <p>
        {detail.queue.waiting
          ? detail.queue.position === null
            ? t('The torrent waits in the queue of the client.')
            : t('The torrent waits in the queue of the client, place {position}.', { position: detail.queue.position })
          : t('The torrent does not wait for a slot.')}{' '}
        {slots === null
          ? t('The queue limits are unknown.')
          : slots.queueing === false
            ? t('Queueing is off in the client.')
            : t('The client allows {downloads} and {torrents}.', {
                downloads: count(slots.maxActiveDownloads, '1 active download', '{n} active downloads'),
                torrents: count(slots.maxActiveTorrents, '1 active torrent', '{n} active torrents'),
              })}
      </p>
      {detail.trackers === null ? (
        <p>{t('Tracker details are unknown.')}</p>
      ) : detail.trackers.length === 0 ? (
        <p>{t('The client lists no tracker.')}</p>
      ) : (
        <ul>
          {detail.trackers.map((tracker, index) => (
            <li key={index}>
              {tracker.host === null ? t('Tracker with an unknown address: {status}', { status: t(trackerLabel[tracker.status]) }) : t('Tracker {host}: {status}', { host: tracker.host, status: t(trackerLabel[tracker.status]) })}
              {tracker.message ? `. ${tracker.message}` : ''}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

