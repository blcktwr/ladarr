import type { TrackerStatus } from '@ladarr/shared/enums';
import type { AttachCandidates, AttachPreview, QueueClientDetail, QueueEntryView } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { Button, Checkbox, Dropdown, EmptyState, Panel, SearchField, Section, Spinner } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { formatBytes } from '../../lib/format.ts';
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

// Attaches a download that was in the client before ladarr looked for it. The user confirms the owner and the title.
function AttachBody({ entry, ids, onDone }: { entry: QueueEntryView; ids?: string[]; onDone: () => void }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [hash, setHash] = useState('');
  const [also, setAlso] = useState<string[]>(() => ids?.filter((id) => id !== entry.id) ?? []);
  const [owner, setOwner] = useState(false);
  const [titleOk, setTitleOk] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AttachPreview | null>(null);

  // A short wait joins the key strokes into one request.
  useEffect(() => {
    const timer = setTimeout(() => setQ(text), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const search = useQuery<AttachCandidates>({ queryKey: [`/queue/entries/${entry.id}/external?q=${encodeURIComponent(q)}`] });
  const found = search.data;
  const searchError = search.error?.message === 'client_unreachable' ? t('The client does not answer.') : search.error?.message === 'client_missing' ? t('No download client is set.') : search.error ? t('The request did not complete.') : '';
  const shown = error || searchError;

  const picked = found?.torrents.find((torrent) => torrent.hash === hash);
  const siblings = found?.siblings ?? [];
  const list = [entry.label, ...siblings.filter((item) => also.includes(item.id)).map((item) => item.label)].join(', ');
  const selection = `${hash}|${[...also].sort().join(',')}`;
  const current = useRef(selection);
  current.current = selection;

  async function attach(show: boolean) {
    if (!show && !preview?.version) return;
    const sent = selection;
    setBusy(true);
    setError('');
    try {
      const result = await api<AttachPreview>(`/queue/entries/${entry.id}/attach`, { method: 'POST', body: { hash, ids: also, confirmOwner: owner, confirmTitle: titleOk, ...(show ? { preview: true } : { version: preview!.version }) } });
      if (show) {
        if (sent === current.current) setPreview(result);
      } else onDone();
    } catch (err) {
      setPreview(null);
      const code = err instanceof ApiError ? err.message : '';
      setError(
        code === 'torrent_in_use'
          ? t('A target of another title uses this download.')
          : code === 'torrent_not_found'
            ? t('The client does not have this download now.')
            : code === 'attach_not_supported'
              ? t('A target is not waiting for a download now.')
              : ['preview_changed', 'preview_required', 'attachment_changed'].includes(code)
                ? t('The preview changed. Preview the attachment again.')
                : t('The request did not complete.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={t('Attach a download to {label}', { label: list })}
      action={
        <div className="flex flex-wrap justify-end gap-2 w-full">
          <Button disabled={!picked || busy} pending={busy && !preview} onClick={() => void attach(true)}>{t('Preview attachment')}</Button>
          {preview && <Button disabled={!preview.version || !owner || !titleOk || busy} pending={busy} onClick={() => void attach(false)}>{t('Attach download')}</Button>}
        </div>
      }
    >
      {shown && <Alert tone="danger">{shown}</Alert>}
      <SearchField aria-label={t('Search the downloads')} value={text} onChange={setText} placeholder={t('Search')} />
      {!found && !shown && <Spinner label={t('Loading downloads')} />}
      {found && found.torrents.length === 0 && <EmptyState>{t('The client has no download for this search.')}</EmptyState>}
      {found && found.torrents.length > 0 && (
        <Dropdown
          label={t('Download')}
          value={hash || null}
          onValueChange={(value) => {
            setHash(value ?? '');
            setPreview(null);
            setOwner(false);
            setTitleOk(false);
          }}
          options={found.torrents.map((torrent) => ({
            value: torrent.hash,
            label: `${torrent.name} (${formatBytes(torrent.sizeBytes)}, ${torrent.complete ? t('complete') : `${Math.round(torrent.progress * 100)}%`}${torrent.category ? `, ${torrent.category}` : ''})`,
          }))}
        />
      )}
      {found && found.total > found.torrents.length && <p>{t('{count} more downloads fit this search. Search by name to find them.', { count: found.total - found.torrents.length })}</p>}
      {picked && siblings.length > 0 && (
        <Section title={t('Also use this download for')}>
          {siblings.map((item) => (
            <Checkbox key={item.id} label={item.label} checked={also.includes(item.id)} onCheckedChange={(on) => {
              setAlso(on ? [...also, item.id] : also.filter((id) => id !== item.id));
              setPreview(null);
            }} />
          ))}
        </Section>
      )}
      {preview && (
        <Section title={t('Changes')}>
          <p>{preview.name}</p>
          <p>{preview.affected.map((item) => item.label).join(', ')}</p>
          {preview.blocked?.map((item) => <p key={item.id}>{item.label}: {item.code} ({item.coverage})</p>)}
        </Section>
      )}
      {picked && (
        <>
          <p>
            {also.length === 0 ? t('1 target changes: {list}.', { list }) : t('{n} targets change: {list}.', { n: 1 + also.length, list })}
          </p>
          <Checkbox label={t('I added this download. It will not be removed from the client.')} checked={owner} onCheckedChange={setOwner} />
          <Checkbox label={t('This download is {label}.', { label: entry.label })} checked={titleOk} onCheckedChange={setTitleOk} />
        </>
      )}
    </Section>
  );
}

export function AttachDialog({ entry, ids, label, onDone }: { entry: QueueEntryView; ids?: string[]; label?: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Panel open={open} onOpenChange={setOpen} label={t('Attach download')} title={label ?? entry.label} trigger={<Button>{t('Attach download')}</Button>}>
      {open && <AttachBody entry={entry} ids={ids} onDone={() => { setOpen(false); onDone(); }} />}
    </Panel>
  );
}
