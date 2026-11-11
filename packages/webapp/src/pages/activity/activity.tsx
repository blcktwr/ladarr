import type { QueueActionName } from '@ladarr/shared/enums';
import type { LogEntry, LogsResponse, QueueActionPreview, QueueEntryView, QueueGroupRow, QueuePage, QueueRejectedRelease, QueueRow, QueueSummary } from '@ladarr/shared/types';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Circle, ExternalLink, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Link as RouterLink } from 'react-router';
import { api, ApiError } from '../../lib/api.ts';
import { ActionMenu, Button, Details, Divider, Dropdown, EmptyState, List, Modal, Pagination, Pane, Panel, Progress, Row, Section, Spinner, SubMenu, Table, Text, Thumbnail } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { JobsPanel } from './activity-jobs.tsx';
import { SeriesBlocklist } from './activity-blocklist.tsx';
import { MatchDialog } from './activity-match.tsx';
import { LoadFailed, ModalActions, pageWidth, TextLink } from '../../components/index.ts';
import { catalogPath, formatBytes, groupName, posterUrl, seasonName, shownCounts, shownKey, stageLabel, statusHelpText, statusLabel } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { LogRow } from '../../lib/log-row.tsx';
import { commentParts } from '../../lib/links.ts';
import { useLive } from '../../lib/live.ts';
import { StatusText } from '../../lib/status.tsx';

// A page of the queue. The table is not virtual, so it shows one page at a time.
const PAGE = 50;
// A page of the episodes of a season in the inspector.
const EPISODES = 12;
// The summary text for a screen reader changes at most once in this time.
const ANNOUNCE_MS = 5_000;
// A series that waits for its episodes has no target yet, so the queue has no event for the end of that wait.
const PENDING_RECHECK_MS = 3_000;
// Below this width the page shows the list or the inspector, not both.
const NARROW = 800;

type Filters = { stage: string };
const query = (f: Filters) => {
  const params = new URLSearchParams();
  if (f.stage) params.set('stage', f.stage);
  return params;
};
const pageKey = (f: Filters, page: number) => `/queue?${query(f)}&limit=${PAGE}&offset=${page * PAGE}`;
const groupKey = (f: Filters, group: QueueGroupRow) => {
  const params = query(f);
  if (group.season !== null) params.set('season', String(group.season));
  return `/queue/groups/${group.titleKey}?${params}`;
};

// The key of a row on the page: one group of episodes, or one movie.
const rowKey = (row: QueueRow) => (row.kind === 'group' ? `group:${row.key}` : `entry:${row.id}`);

// The episodes of a group, for the details and for the sections that read the same entries.
function useGroupEntries(group: QueueGroupRow, filters: Filters) {
  return useQuery<{ items: QueueEntryView[] }>({ queryKey: [groupKey(filters, group)], gcTime: 0, enabled: !group.pending });
}

// The name that the page shows for a row.
const nameOf = (row: QueueRow) => (row.kind === 'group' ? groupName(row) : row.label);

// A target that waits, stopped, or is cancelled has no work to show.
const idle = (entry: QueueEntryView) => entry.reason !== null || entry.branch === 'waiting' || entry.branch === 'cancelled';

// The status at the top of a detail view: the indicator, the message that explains it, and a divider before the
// content below. A series and a movie use this same block, so the two details keep the same spacing.
function DetailStatus({ status, icon, message, divider = true, children }: { status: string; icon: string; message: string | null; divider?: boolean; children?: ReactNode }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <StatusText small status={status} icon={icon} help={message ?? statusHelpText(icon)} />
        {message && <Text variant="small">{message}</Text>}
        {children}
      </div>
      {divider && <Divider />}
    </div>
  );
}

// The status of a target: what it does now. A target that stopped on a reason keeps the indicator of its stage, and
// the hint says why it stopped.
function EntryStatus({ entry }: { entry: QueueEntryView }) {
  const key = shownKey(entry.key);
  return <StatusText small status={statusLabel(key)} icon={key} help={entry.reason ? t(entry.reason.message) : statusHelpText(entry.key)} />;
}

// The comment of a release can hold more than one link, with text beside it. Each link opens in a new tab, and the
// line breaks of the comment stay.
function CommentText({ text }: { text: string }) {
  return (
    <span className="whitespace-pre-wrap">
      {commentParts(text).map((part, index) =>
        typeof part === 'string' ? (
          part
        ) : (
          <TextLink key={index} href={part.href}>
            {part.text}
          </TextLink>
        ),
      )}
    </span>
  );
}

// The release of a target: its name, its quality, and its size.
function ReleaseDetails({ release }: { release: NonNullable<QueueEntryView['release']> }) {
  return (
    <Details
      items={[
        { label: t('Release'), value: release.title, wide: true },
        ...(release.quality ? [{ label: t('Quality'), value: release.quality }] : []),
        { label: t('Size'), value: formatBytes(release.sizeBytes) },
        ...(release.comment ? [{ label: t('Comment'), value: <CommentText text={release.comment} />, wide: true }] : []),
      ]}
    />
  );
}

// The file of an episode: its name, with its size at the end.
function FileDetails({ file }: { file: NonNullable<QueueEntryView['file']> }) {
  return <Text variant="small">{file.name} ({formatBytes(file.sizeBytes)})</Text>;
}

// The steps of the import journal. A check with a higher place is done.
const importStates = ['planned', 'staged', 'published', 'committed', 'retired'] as const;
const importRank = (entry: QueueEntryView) => (entry.import ? importStates.indexOf(entry.import.state) : 0);

// The checks belong to a target that validates or imports. A target that a problem stops has no checks.
const hasChecks = (entry: QueueEntryView) => entry.key !== 'stuck' && (entry.stage === 'validating' || entry.stage === 'importing');

// The checks that ladarr does before a target is complete. The checks of the validation pass together when the plan of
// the import is made. The steps of the import follow one by one.
function ImportChecks({ entry }: { entry: QueueEntryView }) {
  if (!hasChecks(entry)) return null;
  const planned = entry.stage === 'importing';
  const rank = importRank(entry);
  const steps = [
    { label: 'The download is complete.', done: true },
    { label: 'The title and its library folder exist.', done: planned },
    { label: 'The library folder is available.', done: planned },
    { label: 'The download is in the client.', done: planned },
    { label: 'The download folder is readable.', done: planned },
    { label: 'The download folder is inside the downloads folder.', done: planned },
    { label: 'The video files are found.', done: planned },
    { label: 'The destination is inside the library folder.', done: planned },
    { label: 'The file is readable.', done: planned },
    { label: 'The destination name is free.', done: planned },
    { label: 'No two files have the same name.', done: planned },
    { label: 'The file is in the folder of the title.', done: rank >= 1 },
    { label: 'The file has its final name.', done: rank >= 2 },
    { label: 'The library record is updated.', done: rank >= 3 },
    { label: 'The replaced file is removed.', done: rank >= 4 },
  ];
  return (
    <List>
      {steps.map((step) => (
        <Row key={step.label}>
          {step.done ? (
            <Check className="size-4.5 shrink-0 text-success" role="img" aria-label={t('Done')} />
          ) : (
            <Circle className="size-4.5 shrink-0 text-fog" role="img" aria-label={t('Waiting')} />
          )}
          <Text variant="small">{t(step.label)}</Text>
        </Row>
      ))}
    </List>
  );
}

const sourceLabels: Record<string, string> = { webdl: 'WEB-DL', webrip: 'WEBRip', bluray: 'BluRay', hdtv: 'HDTV', dvd: 'DVD', cam: 'CAM', telesync: 'TS' };
const sourceLabel = (source: string) => sourceLabels[source] ?? (source === 'unknown' ? t('Unknown source') : source);

// The quality of a release as a person reads it: its resolution and its source.
const releaseQuality = (release: QueueRejectedRelease) => [release.resolution ? `${release.resolution}p` : null, sourceLabel(release.source)].filter(Boolean).join(' ');

// The size check that stopped a release, with the numbers that made it.
const sizeReason = (release: QueueRejectedRelease) => {
  const rejection = release.sizeRejection;
  if (!rejection) return null;
  return `File size (${rejection.value.toFixed(1)} ${rejection.code === 'size_above_max' ? '>' : '<'} ${rejection.limit}) MiB/min`;
};

// The releases that a search found and rejected, with the button that takes one by hand.
function NoMatchReleases({ items, onDone }: { items: { entry: QueueEntryView; release: QueueRejectedRelease }[]; onDone: () => void }) {
  const [chosen, setChosen] = useState<{ entry: QueueEntryView; release: QueueRejectedRelease } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function close() {
    setChosen(null);
    setError('');
  }

  async function download() {
    if (!chosen) return;
    setBusy(true);
    setError('');
    try {
      await api(`/queue/entries/${chosen.entry.id}/releases/grab`, { method: 'POST', body: { indexerId: chosen.release.indexerId, guid: chosen.release.guid } });
      onDone();
      close();
    } catch (err) {
      setError(err instanceof ApiError && err.message === 'release_rejected' ? t('This release cannot be taken: it breaks a safety check.') : t('The request did not complete.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section title={t('Rejected releases')}>
        <Table
          aria-label={t('Rejected releases')}
          columns={[{ label: t('Release'), hideLabel: true }, { label: t('Actions'), align: 'end', hideLabel: true }]}
          rows={items.map((item) => {
            const quality = releaseQuality(item.release);
            const size = formatBytes(item.release.sizeBytes);
            const reason = sizeReason(item.release);
            return {
              key: `${item.release.indexerId}:${item.release.guid}`,
              cells: [
                <div className="grid gap-1">
                  <Text variant="small">
                    {quality} ({size}){reason ? ` / ${reason}` : ''}
                  </Text>
                  <Text>{item.release.title}</Text>
                </div>,
                <Button iconOnly aria-label={t('Download {quality} {size}', { quality, size })} onClick={() => setChosen(item)}>
                  <Check />
                </Button>,
              ],
            };
          })}
        />
      </Section>
      {chosen && (
        <Modal open onOpenChange={(open) => !open && close()} title={t('Download this release?')}>
          <div className="grid gap-1">
            <Text variant="small">{releaseQuality(chosen.release)}</Text>
            <Text>{chosen.release.title}</Text>
            <Text variant="small">{formatBytes(chosen.release.sizeBytes)}</Text>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <ModalActions>
            <Button variant="ghost" onClick={close}>
              {t('Cancel')}
            </Button>
            <Button pending={busy} onClick={() => void download()}>
              {t('Download')}
            </Button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}

// The rejected releases of a row, in their own container under its details.
function RejectedPane({ items, onDone }: { items: { entry: QueueEntryView; release: QueueRejectedRelease }[]; onDone: () => void }) {
  if (items.length === 0) return null;
  return (
    <Pane className="w-full">
      <NoMatchReleases items={items} onDone={onDone} />
    </Pane>
  );
}

// The rejected releases of a movie. Only a target that found no match keeps them.
function MovieRejected({ entry, refresh }: { entry: QueueEntryView; refresh: () => void }) {
  const releases = entry.key === 'no_match' ? (entry.search?.rejected ?? []) : [];
  return <RejectedPane items={releases.map((release) => ({ entry, release }))} onDone={refresh} />;
}

// The rejected releases of a series, one row for each release. Several episodes can have their own.
function GroupRejected({ group, filters, refresh }: { group: QueueGroupRow; filters: Filters; refresh: () => void }) {
  const { data } = useGroupEntries(group, filters);
  const rejected = new Map<string, { entry: QueueEntryView; release: QueueRejectedRelease }>();
  for (const entry of data?.items ?? []) {
    for (const release of entry.search?.rejected ?? []) {
      const key = `${release.indexerId}:${release.guid}`;
      if (!rejected.has(key)) rejected.set(key, { entry, release });
    }
  }
  return <RejectedPane items={[...rejected.values()]} onDone={refresh} />;
}

// The progress of a download: the part that is done.
function TransferProgress({ entry }: { entry: QueueEntryView }) {
  const percent = downloadPercent(entry);
  if (percent === null || !entry.transfer) return null;
  return (
    <div className="grid gap-1">
      <Progress value={percent} label={`${entry.label} ${t('Download')}`} />
      <Text variant="small">{percent}%</Text>
    </div>
  );
}

// The percent of a download that runs. The list of the episodes of a series shows it in the name, with no bar and no rate.
function downloadPercent(entry: QueueEntryView) {
  if (!entry.transfer || entry.stage !== 'downloading' || idle(entry)) return null;
  return Math.round(entry.transfer.progress * 100);
}

// One target. An episode keeps its indicator next to its name, above the fields of its file. The inspector of a movie
// shows the indicator of its status and the reason that stops it above the progress of the work, under the name, then
// the checks of the import, then the fields of its release. The label is off in the inspector of a movie, where the
// heading of the panel says the name. The actions of an episode, such as the match of a file, follow its indicator.
// An episode of a series shows the percent of its download in its name.
function EntryDetails({ entry, label = true, inline = false, actions }: { entry: QueueEntryView; label?: boolean; inline?: boolean; actions?: ReactNode }) {
  const percent = inline ? downloadPercent(entry) : null;
  const data = !inline && entry.release ? <ReleaseDetails release={entry.release} /> : inline && entry.file ? <FileDetails file={entry.file} /> : null;
  const name = label && <Text>{percent === null ? entry.label : <>{entry.label} <strong>({percent}%)</strong></>}</Text>;
  const status = shownKey(entry.key);
  // The reason shows under the status of a movie, and under the status of an episode that a problem stops, above its
  // file. The list keeps the status and the hint.
  const reason = entry.reason ? t(entry.reason.message) : null;
  const checks = hasChecks(entry);
  if (inline) {
    return (
      <div className="grid gap-2 w-full min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {name}
          <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">
            <EntryStatus entry={entry} />
            {actions}
          </div>
        </div>
        {entry.key === 'stuck' && reason && <Text variant="small">{reason}</Text>}
        {data}
      </div>
    );
  }
  return (
    <div className="grid gap-4 w-full min-w-0">
      {name}
      <DetailStatus status={statusLabel(status)} icon={status} message={reason} divider={!checks && Boolean(data)}>
        <TransferProgress entry={entry} />
      </DetailStatus>
      <ImportChecks entry={entry} />
      {checks && data && <Divider />}
      {data}
    </div>
  );
}

type Run = (action: QueueActionName, ids: string[], group?: { titleKey: string; season: number | null }) => void;

// The actions of a row, in its menu.
function entryMenu(entry: QueueEntryView, run: Run, openLogs: (entry: QueueEntryView) => void): { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[] {
  const items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[] = [];
  const searching = entry.branch === 'waiting';
  // An episode has no search of its own.
  if (entry.branch !== 'paused' && entry.reason?.action === 'retry' && !(searching && entry.number !== null)) items.push({ label: searching ? t('Retry') : t('Try again'), onClick: () => run('retry', [entry.id]) });
  if (entry.lane !== null) items.push({ label: t('Remove priority'), onClick: () => run('unpriority', [entry.id]) });
  if (entry.key === 'available' || entry.key === 'cancelled') {
    if (entry.hasTorrent && !entry.attached) items.push({ label: t('Remove torrent'), onClick: () => run('remove_torrent', [entry.id]) });
    if (!entry.clearedAt) items.push({ label: t('Clear from the list'), onClick: () => run('clear', [entry.id]) });
  }
  items.push({ label: t('Logs'), onClick: () => openLogs(entry) });
  return items;
}

// The time ranges of the logs of a target.
type LogPeriod = 'all' | 'hour' | 'day' | 'week';
const logPeriods: { value: LogPeriod; label: string; ms?: number }[] = [
  { value: 'all', label: 'All time' },
  { value: 'hour', label: 'Last hour', ms: 60 * 60_000 },
  { value: 'day', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { value: 'week', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
];

const logKey = (entryId: string, itemType: string) => `/system/logs?limit=200&kind=logs&type=catalog&itemId=${entryId}&itemType=${itemType}`;

// The events of the entries, for the filter of the events.
const eventsOf = (entries: LogEntry[]) => [...new Set(entries.map((entry) => entry.event).filter((event): event is string => typeof event === 'string' && event !== ''))].sort();

// The entries that fit the filters. A time range counts from the moment that the panel opens.
const shownLogs = (entries: LogEntry[], period: LogPeriod, event: string) => {
  const window = logPeriods.find((item) => item.value === period)?.ms;
  const since = window === undefined ? 0 : Date.now() - window;
  return entries.filter((entry) => (!window || Date.parse(entry.time) >= since) && (!event || entry.event === event));
};

function LogFilters({ period, onPeriod, event, onEvent, events }: { period: LogPeriod; onPeriod: (value: LogPeriod) => void; event: string; onEvent: (value: string) => void; events: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4 w-full">
      <Dropdown label={t('Time')} value={period} options={logPeriods.map((item) => ({ value: item.value, label: t(item.label) }))} onValueChange={(value) => onPeriod((value ?? 'all') as LogPeriod)} />
      <Dropdown label={t('Event')} value={event} options={[{ value: '', label: t('All events') }, ...events.map((item) => ({ value: item, label: item }))]} onValueChange={(value) => onEvent(value ?? '')} />
    </div>
  );
}

// The entries of a log, the newest first.
function LogList({ entries }: { entries: LogEntry[] }) {
  // The newest entry comes first, as in Settings.
  const rows = [...entries].reverse();
  if (rows.length === 0) return <EmptyState>{t('No log entries.')}</EmptyState>;
  return (
    <List>
      {rows.map((entry) => (
        <LogRow key={`${entry.time}|${entry.message}`} entry={entry} />
      ))}
    </List>
  );
}

// The log of a target: the entries that the server wrote for it, as Settings shows them, filtered to this item.
function EntryLogs({ entryId, itemType }: { entryId: string; itemType: string }) {
  // The panel is open while this component is mounted, so the new entries arrive without a reload.
  const { data, error, refetch } = useQuery<LogsResponse>({ queryKey: [logKey(entryId, itemType)], refetchInterval: 2_000 });
  const [period, setPeriod] = useState<LogPeriod>('all');
  const [event, setEvent] = useState('');
  if (error && !data) return <LoadFailed onRetry={() => void refetch()} />;
  if (!data) return <Spinner label={t('Loading')} />;
  return (
    <div className="grid gap-5 w-full">
      <LogFilters period={period} onPeriod={setPeriod} event={event} onEvent={setEvent} events={eventsOf(data.entries)} />
      <LogList entries={shownLogs(data.entries, period, event)} />
    </div>
  );
}

// The general log of a series: the entries that the server wrote for the title, not for its episodes.
function GroupLogs({ titleKey }: { titleKey: string }) {
  return <EntryLogs entryId={titleKey} itemType="tv" />;
}

// The stages of the queue in the order that a group shows them: the work that goes on first, then the waits.
const stageOrder = ['searching', 'fetching', 'sending', 'downloading', 'validating', 'importing', 'stuck', 'not_found', 'no_match', 'queued', 'paused', 'cancelled'];

// The stage of a series or a season: the first one where it has targets.
function groupStage(counts: Record<string, number>) {
  const shown = shownCounts(counts);
  return stageOrder.find((key) => (shown[key] ?? 0) > 0) ?? null;
}

// The stage of a title in the list and in the inspector: the first one where it has targets. A title that is all
// imported has no stage of its own, so it is Available.
function overallKey(counts: Record<string, number>) {
  return groupStage(counts) ?? ((counts.available ?? 0) > 0 ? 'available' : null);
}

// The status of a series or a season, in the same style as the status of a target.
function GroupStatus({ counts }: { counts: Record<string, number> }) {
  const key = overallKey(counts);
  return key ? <StatusText small status={statusLabel(key)} icon={key} /> : <Text variant="small">—</Text>;
}

// The line under the name of a series in the list: its status. The part of its targets that is in the library shows in
// the inspector.
function GroupLine({ group }: { group: QueueGroupRow }) {
  const key = overallKey(group.counts);
  return key ? <StatusText small status={statusLabel(key)} icon={key} /> : <Text variant="small">—</Text>;
}

// The menu of a series in the inspector. A series whose episodes are loading has no target to act on yet.
function groupMenu(group: QueueGroupRow, openLogs: (group: QueueGroupRow) => void) {
  if (group.pending) return [];
  return [{ label: t('Logs'), onClick: () => openLogs(group) }];
}

// One title in the list: the poster, the name as a link to the page of the title, and its status. A click on the rest of
// the row opens the title in the inspector.
function MasterRow({ row }: { row: QueueRow }) {
  return (
    <div className="flex items-center gap-4 min-w-0">
      {/* The name says the title and the year, so the poster has no text. Its empty caption is cut off, so it takes no height. */}
      <div className="shrink-0 h-30 overflow-hidden">
        <Thumbnail size="xs" image={posterUrl(row.posterPath) ?? ''} title="" year="" />
      </div>
      <div className="grid gap-2 min-w-0">
        {/* The name of the row is not a heading: the heading of the page says the section, and the inspector says the title. */}
        <Text variant="body" className="min-w-0">
          <strong>{nameOf(row)}</strong>
        </Text>
        {row.kind === 'group' ? <GroupLine group={row} /> : <EntryStatus entry={row} />}
      </div>
    </div>
  );
}

// The columns of the table of the seasons. The label of a column is for a screen reader only, because the row says it.
const seasonColumns = [{ label: 'Season', hideLabel: true }, { label: 'Actions', hideLabel: true, align: 'end' as const }];

// The episodes of a season, a page of them at a time.
function SeasonEpisodes({ season, entries, run, refresh, openLogs }: { season: number; entries: QueueEntryView[]; run: Run; refresh: () => void; openLogs: (entry: QueueEntryView) => void }) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(entries.length / EPISODES));
  const current = Math.min(page, pages);
  return (
    <div className="grid gap-4 w-full">
      <Table
        aria-label={t('Episodes of season {number}', { number: season })}
        columns={[{ label: t('Episode'), hideLabel: true }]}
        rows={entries.slice((current - 1) * EPISODES, current * EPISODES).map((entry) => ({
          key: `entry:${entry.id}`,
          cells: [
            <EntryDetails
              key="detail"
              entry={entry}
              inline
              actions={
                <>
                  {entry.reason?.action === 'match' && <MatchDialog entry={entry} onDone={refresh} />}
                  <ActionMenu label={t('Actions for {name}', { name: entry.label })} items={entryMenu(entry, run, openLogs)} />
                </>
              }
            />,
          ],
        }))}
      />
      {pages > 1 && <Pagination aria-label={t('Pages')} page={current} count={pages} onPageChange={setPage} />}
    </div>
  );
}

// The seasons of a series, with the part of each one that is in the library. A click on a row or on its button opens the
// episodes of the season under its row, and a second click closes them.
function SeasonTable({ titleKey, entries, opened, onSeason, detail }: { titleKey: string; entries: QueueEntryView[]; opened: number | null; onSeason: (season: number) => void; detail: (season: number) => ReactNode }) {
  const seasons = [...new Set(entries.map((entry) => entry.season).filter((season): season is number => season !== null))].sort((a, b) => a - b);
  if (seasons.length === 0) return <EmptyState>{t('No target fits these filters.')}</EmptyState>;
  return (
    <Table
      aria-label={t('Seasons')}
      columns={seasonColumns.map((column) => ({ ...column, label: t(column.label) }))}
      rows={seasons.map((season) => {
        const name = seasonName(season);
        const episodes = entries.filter((entry) => entry.season === season).length;
        return {
          key: `season:${titleKey}|${season}`,
          onClick: () => onSeason(season),
          detail: opened === season ? detail(season) : undefined,
          cells: [
            <div key="season" className="flex items-baseline gap-1 min-w-0">
              <Text variant="heading" className="min-w-0">
                {name}
              </Text>
              <Text variant="small">({episodes})</Text>
            </div>,
            <Button key="open" variant="ghost" iconOnly aria-label={opened === season ? t('Hide episodes of {name}', { name }) : t('Show episodes of {name}', { name })} onClick={() => onSeason(season)}>
              {opened === season ? <ChevronDown /> : <ChevronRight />}
            </Button>,
          ],
        };
      })}
    />
  );
}

// The inspector of a series: the progress of the whole series, and the seasons. A season opens its episodes under its row.
function GroupDetail({ group, filters, run, refresh, openLogs }: { group: QueueGroupRow; filters: Filters; run: Run; refresh: () => void; openLogs: (entry: QueueEntryView) => void }) {
  const [season, setSeason] = useState<number | null>(null);
  const { data, error, refetch } = useGroupEntries(group, filters);
  const entries = data?.items;
  if (group.pending) {
    return (
      <div className="grid gap-3">
        <GroupStatus counts={group.counts} />
        <div className="grid place-items-center">
          <Spinner label={t('Loading episodes')} />
        </div>
      </div>
    );
  }
  if (error && !entries) return <LoadFailed onRetry={() => void refetch()} />;
  // The skeleton of the table keeps the motion off for a person who asks for less, and it needs no label of its own.
  if (!entries) {
    return <Table aria-label={t('Seasons')} loading columns={seasonColumns.map((column) => ({ ...column, label: t(column.label) }))} />;
  }
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.key] = (counts[entry.key] ?? 0) + 1;
  // The count covers the whole series, not only the episodes that the filter shows. An episode that finished its
  // download counts in validating, importing, and available.
  const completed = group.reached.completed;
  const total = group.total;
  const status = overallKey(counts);
  // The line under the status of a stuck season stays general: the reason of one target is not the reason of them all.
  const stuck = entries.filter((entry) => entry.key === 'stuck').length;
  const toggle = (number: number) => setSeason((current) => (current === number ? null : number));
  // The releases of the series. A pack is one release. Several episodes can have their own.
  const releases = new Map<string, NonNullable<QueueEntryView['release']>>();
  for (const entry of entries) if (entry.release) releases.set(`${entry.release.title}|${entry.release.sizeBytes}`, entry.release);
  const unique = [...releases.values()];
  const qualities = [...new Set(unique.flatMap((release) => (release.quality ? [release.quality] : [])))];
  // The target of the checklist: the one that is furthest behind in the import. A target that a reason stops comes
  // after the targets that move.
  const importing = entries
    .filter(hasChecks)
    .sort((a, b) => Number(Boolean(a.reason)) - Number(Boolean(b.reason)) || (a.stage === b.stage ? importRank(a) - importRank(b) : a.stage === 'validating' ? -1 : 1))[0];
  const message =
    status === 'no_match'
      ? t('The indexers have releases, but none fits your selected qualities.')
      : status === 'stuck'
        ? t('{count} / {total} episodes are stuck. Open seasons below.', { count: stuck, total })
        : t('{count} / {total} episodes', { count: completed, total });
  return (
    <div className="grid min-w-0">
      <div className="grid gap-4">
        {status ? <DetailStatus status={statusLabel(status)} icon={status} message={message} divider={!importing} /> : <Text>—</Text>}
        {importing && <ImportChecks entry={importing} />}
        {importing && unique.length > 0 && <Divider />}
        {unique.length > 0 && (
          <div>
            {unique.length === 1 ? (
              <ReleaseDetails release={unique[0]!} />
            ) : (
              <Details
                items={[
                  { label: t('Releases'), value: unique.length },
                  ...(qualities.length ? [{ label: t('Quality'), value: qualities.join(', ') }] : []),
                  { label: t('Size'), value: formatBytes(unique.reduce((sum, release) => sum + release.sizeBytes, 0)) },
                ]}
              />
            )}
          </div>
        )}
      </div>
      {(unique.length > 0 || importing) && (
        <div className="mt-6">
          <Divider />
        </div>
      )}
      <SeasonTable
        titleKey={group.titleKey}
        entries={entries}
        opened={season}
        onSeason={toggle}
        detail={(number) => <SeasonEpisodes season={number} entries={entries.filter((entry) => entry.season === number)} run={run} refresh={refresh} openLogs={openLogs} />}
      />
    </div>
  );
}

// The inspector of a movie: its status and its progress, with the match of a file when the target asks for it.
function MovieDetail({ entry, refresh }: { entry: QueueEntryView; refresh: () => void }) {
  return (
    <div className="grid gap-3">
      <EntryDetails entry={entry} label={false} />
      {entry.reason?.action === 'match' && <MatchDialog entry={entry} onDone={refresh} />}
    </div>
  );
}

// The inspector of the selected title: its name, its menu, and its progress. The body starts again when the selected
// title changes, so a season of the title before does not stay open.
function Inspector({ row, filters, run, refresh, openLogs, openGroupLogs, onBack, backRef }: { row: QueueRow; filters: Filters; run: Run; refresh: () => void; openLogs: (entry: QueueEntryView) => void; openGroupLogs: (group: QueueGroupRow) => void; onBack: () => void; backRef: Ref<HTMLButtonElement> }) {
  const items = row.kind === 'group' ? groupMenu(row, openGroupLogs) : entryMenu(row, run, openLogs);
  return (
    <div className="grid gap-6 w-full min-w-0">
      {/* The list is under the inspector in a narrow window, so the panel has its own way back. */}
      <div className="flex min-[800px]:hidden">
        <Button ref={backRef} variant="ghost" onClick={onBack}>
          <ArrowLeft />
          {t('Queue')}
        </Button>
      </div>
      <div className="flex items-start justify-between gap-3 w-full">
        <RouterLink to={catalogPath(row.titleKey)} className="flex items-center gap-2 min-w-0">
          <Text variant="heading" className="min-w-0">{nameOf(row)}</Text>
          <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
        </RouterLink>
        {items.length > 0 && <ActionMenu label={t('Actions for {name}', { name: nameOf(row) })} items={items} />}
      </div>
      {row.kind === 'group' ? (
        <GroupDetail key={`${row.key}|${filters.stage}`} group={row} filters={filters} run={run} refresh={refresh} openLogs={openLogs} />
      ) : (
        <MovieDetail key={`${row.id}|${filters.stage}`} entry={row} refresh={refresh} />
      )}
    </div>
  );
}

const keys = ['queued', 'searching', 'downloading', 'importing', 'stuck'];

// The stages of the whole page. The row is wide, so it lies above the container of the queue.
function StageMenu({ summary, filters, setFilters }: { summary: QueueSummary | undefined; filters: Filters; setFilters: (f: Filters) => void }) {
  const counts = shownCounts(summary?.counts ?? {});
  // A target that found no release, or no release that fits the preset, waits for its next search, so it counts in
  // Waiting. Fetching the release belongs to the search, so it counts in Searching. Validating belongs to the import,
  // so it counts in Importing.
  counts.queued = (counts.queued ?? 0) + (summary?.counts.not_found ?? 0) + (summary?.counts.no_match ?? 0);
  counts.searching = (counts.searching ?? 0) + (summary?.counts.fetching ?? 0);
  counts.importing = (counts.importing ?? 0) + (summary?.counts.validating ?? 0);
  return (
    <SubMenu
      fill
      aria-label={t('Stage')}
      value={filters.stage || 'all'}
      onValueChange={(value) => setFilters({ ...filters, stage: value === 'all' ? '' : String(value) })}
      items={[{ value: 'all', label: t('All') }, ...keys.map((key) => ({ value: key, label: stageLabel(key), count: counts[key] ?? 0 }))]}
    />
  );
}

// The question shows in a modal, and the action runs after the second click.
function ConfirmAction({ preview, onCancel, onConfirm }: { preview: QueueActionPreview; onCancel: () => void; onConfirm: () => void }) {
  const count = preview.affected.length;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={count === 1 ? t('{action} 1 target?', { action: t(actionLabel[preview.action]) }) : t('{action} {n} targets?', { action: t(actionLabel[preview.action]), n: count })}
    >
      {preview.sharedTransfers.map((transfer) => (
        <p key={transfer.name}>
          {t('{name} is one download for {count} targets. The action changes the whole download.', { name: transfer.name, count: transfer.entries })}
        </p>
      ))}
      {preview.action === 'remove_torrent' && <p>{t('The files stay on the disk.')}</p>}
      <ul>
        {preview.affected.slice(0, 20).map((item) => (
          <li key={item.id}>
            {item.label} {stageLabel(shownKey(item.key))}
          </li>
        ))}
      </ul>
      {preview.affected.length > 20 && <p>{t('And {count} more.', { count: preview.affected.length - 20 })}</p>}
      {preview.unsupported.length > 0 && <p>{t('{count} targets are not changed, because their stage does not fit this action.', { count: preview.unsupported.length })}</p>}
      <ModalActions>
        <Button variant="ghost" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button onClick={onConfirm}>{t(actionLabel[preview.action])}</Button>
      </ModalActions>
    </Modal>
  );
}

const actionLabel: Record<QueueActionName, string> = {
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Try again',
  priority: 'Prioritize',
  unpriority: 'Remove priority from',
  clear: 'Clear',
  remove_torrent: 'Remove the torrent of',
};

// A text for a screen reader that changes at most once in a while, so a burst of changes reads as one message.
function useSlowText(text: string, ms: number) {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (text === shown) return;
    const id = setTimeout(() => {
      last.current = Date.now();
      setShown(text);
    }, Math.max(0, last.current + ms - Date.now()));
    return () => clearTimeout(id);
  }, [text, shown, ms]);
  return shown;
}

function QueueView() {
  const [filters, setFilters] = useState<Filters>({ stage: '' });
  const [page, setPage] = useState(0);
  const queryClient = useQueryClient();
  const { data: summary } = useQuery<QueueSummary>({ queryKey: ['/queue/summary'], gcTime: 0 });
  const queue = useQuery<QueuePage>({ queryKey: [pageKey(filters, page)], gcTime: 0, placeholderData: keepPreviousData });
  const items = queue.data?.items ?? [];
  const total = queue.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const loading = queue.isPending && !queue.data;
  // A failed refresh must not throw away the rows that the page shows already.
  const failed = queue.isError && !queue.data;

  // The row that the inspector shows. A change of the list can take the selected row away, so the first row is the default.
  const [selected, setSelected] = useState<string | null>(null);
  // A narrow window shows the list or the inspector, not both.
  const [open, setOpen] = useState(false);
  const chosen = items.find((row) => rowKey(row) === selected) ?? items[0];
  const chosenKey = chosen ? rowKey(chosen) : null;
  // The button of the row opens the inspector in a narrow window, and the button of the inspector returns to the list.
  const rowButton = useRef<HTMLButtonElement | null>(null);
  const backButton = useRef<HTMLButtonElement | null>(null);

  const [preview, setPreview] = useState<{ body: Parameters<typeof send>[0]; data: QueueActionPreview } | null>(null);
  const [logs, setLogs] = useState<QueueEntryView | null>(null);
  const [groupLogs, setGroupLogs] = useState<QueueGroupRow | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [viewNote, setViewNote] = useState('');
  const lastCount = useRef<number | null>(null);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const pageRef = useRef(page);
  pageRef.current = page;

  // The announcement shows as an Alert, so it leaves after a while.
  useEffect(() => {
    if (!announcement) return;
    const id = setTimeout(() => {
      setAnnouncement('');
    }, ANNOUNCE_MS);
    return () => clearTimeout(id);
  }, [announcement]);

  useEffect(() => {
    lastCount.current = null;
  }, [filters]);
  // A filter can shrink the list below the page that is open.
  useEffect(() => {
    if (!queue.isPlaceholderData && page > pages - 1) setPage(pages - 1);
  }, [page, pages, queue.isPlaceholderData]);

  // Changes arrive together. A short wait joins a burst into one load of the page, the groups, and the summary.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ['/queue/summary'] });
      void queryClient.invalidateQueries({ queryKey: [pageKey(filtersRef.current, pageRef.current)] });
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/queue/groups/') });
    }, 300);
  }, [queryClient]);
  useLive('queue.changed', refresh);
  // The client reports the part of each file at every poll, and the rows show it.
  useLive('queue.progress', refresh);
  // A title that loads its episodes, or leaves the library, changes the pending row of the queue.
  useLive('library.changed', refresh);
  // The row of a series that waits for its episodes depends on a job, and the end of that wait can arrive with no
  // event of its own. The page reads the queue again until the pending row becomes a real one.
  const pending = items.some((row) => row.kind === 'group' && row.pending);
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(refresh, PENDING_RECHECK_MS);
    return () => clearInterval(id);
  }, [pending, refresh]);

  // The count of the view changes with the filters and with the work. The screen reader hears it, and the focus stays.
  useEffect(() => {
    if (loading) return;
    if (lastCount.current !== null && lastCount.current !== total) setViewNote(total === 1 ? t('1 row in this view') : t('{count} rows in this view', { count: total }));
    lastCount.current = total;
  }, [total, loading]);

  async function send(body: { action: QueueActionName; ids?: string[]; group?: { titleKey: string; season: number | null } }) {
    try {
      await api('/queue/actions', { method: 'POST', body });
      refresh();
    } catch (err) {
      setAnnouncement(err instanceof ApiError && err.message === 'client_unreachable' ? t('The download client does not answer. Nothing changed.') : t('The action did not complete.'));
    }
  }

  // An action on a group, or on a shared download, shows every target that it changes before it starts.
  const run = useCallback(async (action: QueueActionName, ids: string[], group?: { titleKey: string; season: number | null }) => {
    const body = group ? { action, group } : { action, ids };
    try {
      const data = await api<QueueActionPreview>('/queue/actions', { method: 'POST', body: { ...body, preview: true } });
      if (data.affected.length === 0) setAnnouncement(t(data.unsupported[0]?.reason ?? 'Nothing to change.'));
      else if (data.affected.length > 1 || data.sharedTransfers.length || group) setPreview({ body, data });
      else await send(body);
    } catch {
      setAnnouncement(t('The action did not complete.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A click on a row selects it. In a narrow window the list goes away, so the inspector shows at once.
  const inspect = (row: QueueRow) => {
    setSelected(rowKey(row));
    if (window.matchMedia(`(max-width: ${NARROW - 1}px)`).matches) setOpen(true);
  };

  // The inspector of a narrow window covers the list. The focus moves with the view, so the keyboard stays in the part
  // that shows.
  useEffect(() => {
    if (open) backButton.current?.focus();
  }, [open]);

  const back = () => {
    setOpen(false);
    requestAnimationFrame(() => rowButton.current?.focus());
  };

  // A filter or a page shows a new set of rows, so the inspector starts at its first row and the list shows again.
  useEffect(() => {
    setSelected(null);
    setOpen(false);
  }, [filters, page]);

  const rows = items.map((row) => ({
    key: rowKey(row),
    onClick: () => inspect(row),
    cells: [
      <MasterRow key="title" row={row} />,
      <Button
        key="inspect"
        variant="ghost"
        iconOnly
        aria-label={t('Inspect {name}', { name: nameOf(row) })}
        aria-pressed={rowKey(row) === chosenKey}
        ref={rowKey(row) === chosenKey ? rowButton : undefined}
        onClick={() => inspect(row)}
      >
        <ChevronRight />
      </Button>,
    ],
  }));

  const slowNote = useSlowText(viewNote, ANNOUNCE_MS);
  const empty = !loading && !failed && total === 0;
  const paused = summary?.paused ?? false;
  // The queue cannot work without an indexer and a client, so the pause has nothing to stop.
  const blocked = Boolean(summary && (!summary.indexers || !summary.hasClient));

  // The pause starts no new work, and the running work ends.
  async function setPaused(value: boolean) {
    try {
      await api('/queue/pause', { method: 'POST', body: { paused: value } });
      void queryClient.invalidateQueries({ queryKey: ['/queue/summary'] });
    } catch {
      setAnnouncement(t('The action did not complete.'));
    }
  }

  return (
    <div className={`${pageWidth} grid gap-6`}>
      <div className="flex items-center gap-3 w-full">
        <Text variant="title">{t('Queue')}</Text>
        <div className="ml-auto flex items-center gap-3">
          <JobsPanel />
          <Button iconOnly disabled={blocked} aria-label={paused ? t('Resume the queue') : t('Pause the queue')} onClick={() => void setPaused(!paused)}>
            {paused ? <Play /> : <Pause />}
          </Button>
        </div>
      </div>
      <StageMenu
        summary={summary}
        filters={filters}
        setFilters={(next) => {
          setFilters(next);
          setPage(0);
        }}
      />
      {/* The note is for a screen reader only, so it is on the page and not in a pane. */}
      <p role="status" aria-live="polite" data-slow-note className="sr-only">
        {slowNote}
      </p>
      {announcement && <Alert tone="warning">{announcement}</Alert>}
      {failed && (
        <Pane className="w-full">
          <LoadFailed onRetry={() => void queryClient.refetchQueries({ queryKey: [pageKey(filters, page)] })} />
        </Pane>
      )}
      {empty && (
        <Pane className="w-full">
          <EmptyState>{filters.stage ? t('No target fits these filters.') : t('Nothing is in the queue.')}</EmptyState>
        </Pane>
      )}
      {!failed && !empty && (
        <div className="grid gap-6 min-[800px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] min-[800px]:items-start">
          {/* A narrow window shows the list alone while the inspector is closed. */}
          <div className={`grid gap-4 min-w-0 ${open ? 'max-[800px]:hidden' : ''}`}>
            <Pane className="w-full">
              <Table
                aria-label={t('Queue')}
                loading={loading}
                animated
                columns={[
                  { label: t('Title'), hideLabel: true },
                  { label: t('Actions'), hideLabel: true, align: 'end' },
                ]}
                rows={rows}
              />
            </Pane>
            {/* The page control lies under the pane, so the table keeps the whole pane and the control is not part of its container. */}
            {pages > 1 && <Pagination aria-label={t('Pages')} page={page + 1} count={pages} onPageChange={(next) => setPage(next - 1)} />}
          </div>
          {/* The inspector takes the height of its content. A tall detail grows down the page, and the pane has no scroll. */}
          <div className={`grid gap-6 min-w-0 ${open ? '' : 'max-[800px]:hidden'}`}>
            {chosen ? (
              <>
                <Pane className="w-full">
                  <Inspector row={chosen} filters={filters} run={run} refresh={refresh} openLogs={setLogs} openGroupLogs={setGroupLogs} onBack={back} backRef={backButton} />
                </Pane>
                {chosen.kind === 'group' ? (
                  <>
                    <GroupRejected group={chosen} filters={filters} refresh={refresh} />
                    <Pane className="w-full">
                      <SeriesBlocklist titleKey={chosen.titleKey} />
                    </Pane>
                  </>
                ) : (
                  <MovieRejected entry={chosen} refresh={refresh} />
                )}
              </>
            ) : (
              <Pane className="w-full">
                <div className="grid place-items-center">
                  <Spinner label={t('Loading')} />
                </div>
              </Pane>
            )}
          </div>
        </div>
      )}
      {/* The log of a target is a side panel, so it needs no place on the page. */}
      {logs && (
        <Panel open onOpenChange={(open) => !open && setLogs(null)} label={t('Logs of {label}', { label: logs.label })} title={t('Logs of {label}', { label: logs.label })} size="xl">
          <EntryLogs entryId={logs.id} itemType={logs.mediaType} />
        </Panel>
      )}
      {groupLogs && (
        <Panel open onOpenChange={(open) => !open && setGroupLogs(null)} label={t('Logs of {label}', { label: groupName(groupLogs) })} title={t('Logs of {label}', { label: groupName(groupLogs) })} size="xl">
          <GroupLogs titleKey={groupLogs.titleKey} />
        </Panel>
      )}
      {/* The question of an action is a modal, so it needs no place on the page. */}
      {preview && (
        <ConfirmAction
          preview={preview.data}
          onCancel={() => setPreview(null)}
          onConfirm={() => {
            const body = preview.body;
            setPreview(null);
            void send(body);
          }}
        />
      )}
    </div>
  );
}

export function Activity() {
  return <QueueView />;
}
