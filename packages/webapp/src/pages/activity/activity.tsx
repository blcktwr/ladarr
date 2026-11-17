import type { QueueActionName } from '@ladarr/shared/enums';
import { RETRY_STATUSES } from '@ladarr/shared/queue';
import type { LogEntry, LogsResponse, Numbering, PlanRequest, QueueActionPreview, QueueEntryView, QueueGroupPage, QueueGroupRow, QueuePage, QueueRejectedRelease, QueueResolution, QueueRow, QueueSummary, QueueTorrent } from '@ladarr/shared/types';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Circle, ExternalLink, FileText, FileVideo, Info, LoaderCircle, Pause, Play, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Link as RouterLink } from 'react-router';
import { api, ApiError } from '../../lib/api.ts';
import { ActionMenu, Button, Details, Divider, Dropdown, EmptyState, List, Modal, Pagination, Pane, Panel, Progress, Row, Section, Spinner, SubMenu, Table, Text, Thumbnail, Tree, type TreeNode } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { Confirm } from '../../components/confirm.tsx';
import { JobsPanel } from './activity-jobs.tsx';
import { FinishedPanel } from './activity-finished.tsx';
import { MatchDialog } from './activity-match.tsx';
import { AttachDialog } from './activity-client.tsx';
import { ReleasePicker } from './activity-releases.tsx';
import { PlanDialog } from '../library/library-bulk.tsx';
import { Link, LoadFailed, ModalActions, pageWidth, TextLink } from '../../components/index.ts';
import { NumberingDialog } from '../../components/numbering.tsx';
import { catalogPath, formatBytes, groupName, posterUrl, reasonText, seasonName, stageLabel, statusHelpText, statusLabel } from '../../lib/format.ts';
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

// The key of a row on the page: one group of episodes, one movie, or a series that loads its episodes.
const rowKey = (row: QueueRow) => (row.kind === 'group' ? `group:${row.key}` : row.kind === 'pending' ? `pending:${row.key}` : `entry:${row.id}`);

// The episodes of a group, for the details and for the sections that read the same entries. The response carries the
// aggregate of the whole group beside the filtered items.
function useGroupEntries(group: QueueGroupRow, filters: Filters) {
  return useQuery<QueueGroupPage>({ queryKey: [groupKey(filters, group)], gcTime: 0 });
}

// The name that the page shows for a row.
const nameOf = (row: QueueRow) => (row.kind === 'entry' ? row.label : groupName(row));

// The status at the top of a detail view: the indicator, the message that explains it, and a divider before the
// content below. A series and a movie use this same block, so the two details keep the same spacing. The bar of a
// series shows the part of its download while the client downloads it, and the part of its episodes that is complete
// otherwise, above the message that counts them.
function DetailStatus({ status, icon, message, bar, divider = true, action, children }: { status: string; icon: string; message: string | null; bar?: ReactNode; divider?: boolean; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <StatusText small status={status} icon={icon} help={message ?? statusHelpText(icon)} />
        {bar}
        {message && <Text variant="small">{message}</Text>}
        {action && <div className="flex justify-end gap-2 mt-2 w-full">{action}</div>}
        {children}
      </div>
      {divider && <Divider />}
    </div>
  );
}

// The status of a target: what it does now. A target that stopped shows Stuck, and the hint says why it stopped.
function EntryStatus({ entry }: { entry: QueueEntryView }) {
  return <StatusText small status={statusLabel(entry.status)} icon={entry.status} help={entry.reason ? t(entry.reason.message) : statusHelpText(entry.status)} />;
}

// The same fix for one target or for several targets of a season. The preview of the action names every target that it
// changes.
function ReplaceAllFix({ ids, run }: { ids: string[]; run: Run }) {
  return <Confirm label={t('Replace file')} title={t('Replace the file?')} confirm={t('Replace')} onConfirm={() => void run('replace', ids)} />;
}

// The target of a manual search: the title, and the season and the episode when the target has them.
const targetOf = (entry: QueueEntryView) => ({ titleKey: entry.titleKey, ...(entry.season === null ? {} : { season: entry.season }), ...(entry.number === null ? {} : { number: entry.number }) });

const retryActions = new Set<QueueResolution['action']>(['retry', 'retry_fetch', 'retry_send', 'check_download', 'retry_import']);

// The server supplies each action and its explicit target scope.
function EntryFix({ entry, entries = [entry], actions = entry.actions, run, refresh }: { entry: QueueEntryView; entries?: QueueEntryView[]; actions?: QueueResolution[]; run: Run; refresh: () => void }) {
  const [numbering, setNumbering] = useState(false);
  return (
    <>
      {actions?.map((item) => {
        const action = item.action;
        if (retryActions.has(action)) return null;
        const targets = entries.filter((target) => item.ids.includes(target.id));
        const target = targets[0] ?? entry;
        const label = targets.map((target) => target.label).join(', ') || target.label;
        switch (action) {
          case 'edit_numbering':
            return <Button key={item.action} onClick={() => setNumbering(true)}>{t(item.label)}</Button>;
          case 'match':
          case 'use_existing':
            return <MatchDialog key={item.action} entry={target} ids={item.ids} label={item.label} fileSource={item.fileSource ?? (action === 'use_existing' ? 'library' : undefined)} fixedSource={action === 'use_existing'} onDone={refresh} />;
          case 'attach':
            return <AttachDialog key={item.action} entry={target} ids={item.ids} label={label} onDone={refresh} />;
          case 'search_releases':
            return <ReleasePicker key={item.action} target={item.ids.length === 1 ? targetOf(target) : { titleKey: target.titleKey, ...(target.season === null ? {} : { season: target.season }) }} ids={item.ids} label={label} onDone={refresh} />;
          case 'replace':
            return <ReplaceAllFix key={item.action} ids={item.ids} run={run} />;
          case 'settings':
            return <Link key={item.action} href={`/settings#${item.settings === 'library' ? 'media' : 'connections'}`}>{t(item.label)}</Link>;
          default:
            return <Button key={`${action}:${item.label}`} onClick={() => void run(action, item.ids, undefined, item.label)}>{t(item.label)}</Button>;
        }
      })}
      <NumberingDialog titleKey={entry.titleKey} open={numbering} onOpenChange={setNumbering} onSaved={refresh} />
    </>
  );
}

// Each cause and source keeps its own affected episodes and actions.
function GroupFix({ actions, stopped, run, refresh }: { actions: QueueResolution[]; stopped: QueueEntryView[]; run: Run; refresh: () => void }) {
  const visible = actions.filter((item) => !retryActions.has(item.action));
  const available = visible.some((item) => item.action === 'match') ? visible.filter((item) => item.action !== 'edit_numbering') : visible;
  if (!available.length) return null;
  const groups = new Map<string, { entries: QueueEntryView[]; actions: QueueResolution[] }>();
  const common = new Map<string, QueueResolution>();
  for (const item of available) {
    if (!['edit_numbering', 'match', 'apply_numbering', 'search_releases', 'replace'].includes(item.action)) continue;
    const current = common.get(item.action);
    common.set(item.action, { ...(current ?? item), ids: [...new Set([...(current?.ids ?? []), ...item.ids])] });
  }
  for (const entry of stopped) {
    const descriptors = available.filter((item) => item.ids.includes(entry.id));
    const key = JSON.stringify([entry.phase, entry.reason?.code, entry.reason?.detail, descriptors[0]?.source ?? entry.release?.title ?? entry.file?.name]);
    const group = groups.get(key) ?? { entries: [], actions: descriptors };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return (
    <div className="flex flex-wrap justify-start gap-2 mt-2 w-full">
      {[...groups].map(([key, group]) => {
        const ids = group.entries.map((item) => item.id);
        const local = group.actions.filter((item) => !common.has(item.action)).map((item) => ({ ...item, ids: item.ids.filter((id) => ids.includes(id)) }));
        return <EntryFix key={key} entry={group.entries[0]!} entries={group.entries} actions={local} run={run} refresh={refresh} />;
      })}
      {stopped[0] && [...common.values()].map((item) => (
        <EntryFix key={item.action} entry={stopped[0]} entries={stopped} actions={[item]} run={run} refresh={refresh} />
      ))}
    </div>
  );
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

// The files of the torrent as a tree: the folders keep their files, and each level shows its files before its folders.
function torrentTree(data: QueueTorrent): TreeNode[] {
  const items: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();
  for (const file of data.files) {
    const parts = file.path.split('/');
    const start = parts.length > 1 && parts[0] === data.name ? 1 : 0;
    let children = items;
    for (let index = start; index < parts.length - 1; index++) {
      const key = parts.slice(0, index + 1).join('/');
      let folder = folders.get(key);
      if (!folder) {
        folder = { key, name: parts[index]!, children: [] };
        folders.set(key, folder);
        children.push(folder);
      }
      children = folder.children!;
    }
    children.push({
      key: file.path,
      name: parts[parts.length - 1]!,
      size: formatBytes(file.sizeBytes),
      icon: /\.(mkv|mp4|m4v|avi|mov|wmv|ts|webm)$/i.test(file.path) ? <FileVideo /> : <FileText />,
    });
  }
  const filesFirst = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(a.children !== undefined) - Number(b.children !== undefined));
    for (const node of nodes) if (node.children) filesFirst(node.children);
  };
  filesFirst(items);
  return items;
}

// What the .torrent of the release holds: what the file says about itself, and its files. The modal is the pane, so the
// blocks follow each other with a groove between them, and no other box goes inside.
function TorrentInfo({ path }: { path: string }) {
  const { data, error } = useQuery<QueueTorrent>({ queryKey: [path] });
  // The alert of the app shows under the modal, so the error shows in the modal.
  if (error) return <p role="alert">{t('The file list of the torrent is not available.')}</p>;
  if (!data) {
    // The wheel turns over a box of its own size, and its corners go past that box. Clipping them keeps the page still.
    return (
      <div className="grid place-items-center w-full overflow-hidden">
        <Spinner label={t('Loading files')} />
      </div>
    );
  }
  return (
    <>
      <Details
        columns={4}
        items={[
          ...(data.pieceCount !== null
            ? [{ label: t('Pieces'), value: data.pieceLength === null ? data.pieceCount : `${data.pieceCount} (${formatBytes(data.pieceLength)})` }]
            : []),
          { label: t('Size'), value: formatBytes(data.totalBytes) },
          ...(data.resolution ? [{ label: t('Resolution'), value: `${data.resolution}p` }] : []),
          ...(data.quality ? [{ label: t('Quality'), value: data.quality }] : []),
          ...(data.createdBy ? [{ label: t('Created by'), value: data.createdBy, wide: true }] : []),
          ...(data.comment ? [{ label: t('Comment'), value: <CommentText text={data.comment} />, wide: true }] : []),
        ]}
      />
      <Divider />
      <Section title={t('Files ({count})', { count: data.files.length })}>
        <Tree aria-label={t('Files in the torrent')} items={torrentTree(data)} />
      </Section>
    </>
  );
}

// The release of a target: its name, its quality, and its size. The button at the end of the name opens what the .torrent
// of the release holds.
function ReleaseDetails({ entryId, release }: { entryId: string; release: NonNullable<QueueEntryView['release']> }) {
  return (
    <Details
      items={[
        {
          label: t('Release'),
          value: (
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">{release.title}</span>
              <Modal trigger={<Button iconOnly variant="ghost" aria-label={t('Files in the torrent')}><Info /></Button>} title={t('Torrent')} width="lg">
                <TorrentInfo path={`/queue/entries/${entryId}/torrent`} />
              </Modal>
            </div>
          ),
          wide: true,
        },
        ...(release.quality ? [{ label: t('Quality'), value: release.quality }] : []),
        { label: t('Size'), value: formatBytes(release.sizeBytes) },
        ...(release.comment ? [{ label: t('Comment'), value: <CommentText text={release.comment} />, wide: true }] : []),
      ]}
    />
  );
}

// The file of an episode: its name, with its size at the end. A long name breaks anywhere, so it wraps under the name of
// the episode and does not widen the table.
function FileDetails({ file }: { file: NonNullable<QueueEntryView['file']> }) {
  return <Text variant="small"><span className="[overflow-wrap:anywhere]">{file.name}</span> ({formatBytes(file.sizeBytes)})</Text>;
}

// The checks belong to a target that validates or imports. A target outside those stages has none.
const hasChecks = (entry: QueueEntryView) => Boolean(entry.checks?.length);

// The checklist belongs to the importing indicator. A target that stopped keeps its checks, but the reason and its
// options replace the list.
const showsChecks = (entry: QueueEntryView) => entry.status === 'importing' && hasChecks(entry);

// The checks that ladarr does before a target is complete, in the order that the server sends them.
function ImportChecks({ entry }: { entry: QueueEntryView }) {
  const checks = showsChecks(entry) ? entry.checks : null;
  if (!checks) return null;
  return (
    <List>
      {checks.map((check) => (
        <Row key={check.id}>
          {check.state === 'running' ? (
            <LoaderCircle className="size-4.5 shrink-0 text-accent animate-spin motion-reduce:animate-none" role="img" aria-label={t('Importing')} />
          ) : check.state === 'ok' ? (
            <Check className="size-4.5 shrink-0 text-success" role="img" aria-label={t('Done')} />
          ) : check.state === 'failed' ? (
            <X className="size-4.5 shrink-0 text-error" role="img" aria-label={t('Failed')} />
          ) : (
            <Circle className="size-4.5 shrink-0 text-fog" role="img" aria-label={t('Waiting')} />
          )}
          <Text variant="small">{t(`import_check.${check.id}`)}</Text>
        </Row>
      ))}
    </List>
  );
}

const sourceLabels: Record<string, string> = { webdl: 'WEB-DL', webrip: 'WEBRip', bluray: 'BluRay', hdtv: 'HDTV', dvd: 'DVD', cam: 'CAM', telesync: 'TS' };
const sourceLabel = (source: string) => sourceLabels[source] ?? (source === 'unknown' ? t('Unknown source') : source);

// The quality of a release as a person reads it: its resolution and its source.
const releaseQuality = (release: QueueRejectedRelease) => [release.resolution ? `${release.resolution}p` : null, sourceLabel(release.source)].filter(Boolean).join(' ');

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
            return {
              key: `${item.release.indexerId}:${item.release.guid}`,
              cells: [
                <div className="grid gap-1">
                  <Text variant="small">
                    {quality} ({size})
                  </Text>
                  <Text><span className="[overflow-wrap:anywhere]">{item.release.title}</span></Text>
                  {item.release.reasons.map((text) => (
                    <Text key={text} variant="small">
                      {t(text)}
                    </Text>
                  ))}
                </div>,
                <div className="flex items-center justify-end gap-2">
                  <Modal
                    trigger={<Button iconOnly variant="ghost" aria-label={t('Files in the torrent')}><Info /></Button>}
                    title={t('Torrent')}
                    width="lg"
                  >
                    <TorrentInfo path={`/queue/entries/${item.entry.id}/releases/torrent?indexerId=${item.release.indexerId}&guid=${encodeURIComponent(item.release.guid)}`} />
                  </Modal>
                  <Button iconOnly aria-label={t('Download {quality} {size}', { quality, size })} onClick={() => setChosen(item)}>
                    <Check />
                  </Button>
                </div>,
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
  const releases = entry.status === 'no_match' ? (entry.search?.rejected ?? []) : [];
  return <RejectedPane items={releases.map((release) => ({ entry, release }))} onDone={refresh} />;
}

// The rejected releases of a series, one row for each release. Only a series that found no match keeps them.
function GroupRejected({ group, filters, refresh }: { group: QueueGroupRow; filters: Filters; refresh: () => void }) {
  const { data } = useGroupEntries(group, filters);
  const status = data?.group?.status ?? group.status;
  if (status !== 'no_match') return null;
  const rejected = new Map<string, { entry: QueueEntryView; release: QueueRejectedRelease }>();
  for (const entry of data?.items ?? []) {
    if (entry.status !== 'no_match') continue;
    for (const release of entry.search?.rejected ?? []) {
      const key = `${release.indexerId}:${release.guid}`;
      if (!rejected.has(key)) rejected.set(key, { entry, release });
    }
  }
  return <RejectedPane items={[...rejected.values()]} onDone={refresh} />;
}

// The progress of a download: the part that is done.
function TransferProgress({ entry }: { entry: QueueEntryView }) {
  if (entry.status !== 'downloading') return null;
  // The first poll can arrive after the target enters Downloading. The bar shows from 0% until then.
  const percent = downloadPercent(entry) ?? 0;
  return (
    <div className="grid gap-1">
      <Progress value={percent} label={`${entry.label} ${t('Download')}`} />
      <Text variant="small">{percent}%</Text>
    </div>
  );
}

// The percent of a download that runs. The list of the episodes of a series shows it in the name, with no bar and no rate.
function downloadPercent(entry: QueueEntryView) {
  if (!entry.transfer || entry.status !== 'downloading') return null;
  return Math.round(entry.transfer.progress * 100);
}

// One target. An episode keeps its indicator next to its name, above the fields of its file. The inspector of a movie
// shows the indicator of its status and the reason that stops it above the progress of the work, under the name, then
// the checks of the import while it imports, then the fields of its release. The label is off in the inspector of a
// movie, where the heading of the panel says the name. An episode of a series shows the percent of its download in its name.
function EntryDetails({ entry, label = true, inline = false, actions, fix }: { entry: QueueEntryView; label?: boolean; inline?: boolean; actions?: ReactNode; fix?: ReactNode }) {
  const percent = inline ? downloadPercent(entry) : null;
  const data = !inline && entry.release ? <ReleaseDetails entryId={entry.id} release={entry.release} /> : inline && entry.file ? <FileDetails file={entry.file} /> : null;
  const name = label && <Text>{percent === null ? entry.label : <>{entry.label} <strong>({percent}%)</strong></>}</Text>;
  const status = entry.status;
  // The reason shows under the status of a movie. An episode keeps the reason in its status hint.
  const reason = entry.reason ? reasonText(entry.reason) : null;
  const checks = showsChecks(entry);
  // The container of the action is not rendered when the reason has no option to show.
  const action = entry.actions?.some((item) => !retryActions.has(item.action)) ? fix : undefined;
  if (inline) {
    return (
      <div className="grid gap-2 w-full min-w-0">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">{name}</div>
          <div className="flex shrink-0 items-center justify-end gap-2">
            {entry.status !== 'available' && <EntryStatus entry={entry} />}
            {fix}
            {actions}
          </div>
        </div>
        {data}
      </div>
    );
  }
  return (
    <div className="grid gap-4 w-full min-w-0">
      {name}
      <DetailStatus status={statusLabel(status)} icon={status} message={reason} divider={!checks && Boolean(data)} action={action}>
        {status === 'stuck' && <Text variant="small">{stageLabel(entry.phase)}</Text>}
        <TransferProgress entry={entry} />
      </DetailStatus>
      {checks && <ImportChecks entry={entry} />}
      {checks && data && <Divider />}
      {data}
    </div>
  );
}

type Run = (action: QueueActionName, ids: string[], group?: { titleKey: string; season: number | null }, label?: string) => Promise<void>;

// The actions of a row, in its menu. A target that a problem stops, and a target that waits for its next search with a
// result, take a retry: the phases of the target run again, from the file in the library to a new search.
function entryMenu(entry: QueueEntryView, run: Run, openLogs: (entry: QueueEntryView) => void): { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[] {
  const items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[] = [];
  if (RETRY_STATUSES.includes(entry.status)) items.push({ label: t('Try again'), onClick: () => run('retry', [entry.id]) });
  if (entry.lane !== null) items.push({ label: t('Delete priority'), onClick: () => run('unpriority', [entry.id]) });
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

// The status of a group, in the same style as the status of a target. The server sends the aggregate of the whole
// group, so the row and the inspector show the same status.
function GroupStatus({ status }: { status: QueueGroupRow['status'] }) {
  return status ? <StatusText small status={statusLabel(status)} icon={status} /> : <Text variant="small">—</Text>;
}

// The line under the name of a series in the list: its status. The part of its targets that is in the library shows in
// the inspector.
function GroupLine({ group }: { group: QueueGroupRow }) {
  return <GroupStatus status={group.status} />;
}

// The menu of a series in the inspector. A series whose episodes are loading has no target to act on yet.
function groupMenu(group: QueueGroupRow, openLogs: (group: QueueGroupRow) => void, run: Run) {
  const items = [{ label: t('Logs'), onClick: () => openLogs(group) }];
  // The episodes that wait for their next search, or that a problem stops, start again together from the row.
  if (RETRY_STATUSES.some((status) => (group.counts[status] ?? 0) > 0)) items.unshift({ label: t('Try again'), onClick: () => run('retry', [], { titleKey: group.titleKey, season: group.season }) });
  return items;
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
        {row.kind === 'group' ? <GroupLine group={row} /> : row.kind === 'pending' ? <StatusText small status={statusLabel('searching')} icon="searching" /> : <EntryStatus entry={row} />}
      </div>
    </div>
  );
}

// The columns of the table of the seasons. The label of a column is for a screen reader only, because the row says it.
const seasonColumns = [{ label: 'Season', hideLabel: true }, { label: 'Actions', hideLabel: true, align: 'end' as const }];

// The episodes of a season, a page of them at a time.
function SeasonEpisodes({ season, entries }: { season: number; entries: QueueEntryView[] }) {
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
function GroupDetail({ group, filters, run, refresh }: { group: QueueGroupRow; filters: Filters; run: Run; refresh: () => void }) {
  const [season, setSeason] = useState<number | null>(null);
  const { data, error, refetch } = useGroupEntries(group, filters);
  const entries = data?.items;
  if (error && !entries) return <LoadFailed onRetry={() => void refetch()} />;
  // The skeleton of the table keeps the motion off for a person who asks for less, and it needs no label of its own.
  if (!entries) {
    return <Table aria-label={t('Seasons')} loading columns={seasonColumns.map((column) => ({ ...column, label: t(column.label) }))} />;
  }
  // The counts, the status, and the problem cover the whole series, not only the episodes that the filter shows.
  const summary = data?.group;
  const status = summary?.status ?? group.status;
  const completed = summary?.reached.completed ?? group.reached.completed;
  const total = summary?.total ?? group.total;
  const download = summary?.download ?? group.download;
  const toggle = (number: number) => setSeason((current) => (current === number ? null : number));
  // The releases of the series. A pack is one release. Several episodes can have their own.
  const releases = new Map<string, NonNullable<QueueEntryView['release']>>();
  for (const entry of entries) if (entry.release) releases.set(`${entry.release.title}|${entry.release.sizeBytes}`, entry.release);
  const unique = [...releases.values()];
  // The target that carries the release of the series. The .torrent of the release is the same for every episode of a pack.
  const releaseEntry = entries.find((entry) => entry.release);
  const qualities = [...new Set(unique.flatMap((release) => (release.quality ? [release.quality] : [])))];
  // The checklist belongs to the importing indicator. Every target of a pack carries the same list, so the first
  // importing episode shows it.
  const importing = status === 'importing' ? entries.find(showsChecks) : undefined;
  // The episodes that a problem stopped. One of them shows its own fix on the row of the season.
  const stopped = entries.filter((entry) => entry.status === 'stuck');
  const message =
    status === 'no_match'
      ? t('The indexers have releases, but none fits your selected qualities.')
      : t('{count} / {total} episodes', { count: completed, total });
  // The bar of the whole series: the part of its episodes that is complete, or the part of its download that the
  // client reports while it downloads. A series that waits for its turn, that searches, that the search did not find,
  // that found no match, or that is stuck has no work to fill.
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const bar =
    status === 'queued' || status === 'searching' || status === 'not_found' || status === 'no_match' || status === 'stuck' ? undefined : status === 'downloading' ? (
      <Progress value={Math.round((download ?? 0) * 100)} label={`${groupName(group)} ${t('Download')}`} />
    ) : (
      <Progress value={percent} label={t('{count} / {total} episodes', { count: completed, total })} />
    );
  return (
    <div className="grid min-w-0">
      <div className="grid gap-4">
        {status ? (
          <DetailStatus
            status={statusLabel(status)}
            icon={status}
            bar={bar}
            message={message}
            divider={!importing}
          >
            {stopped.length > 0 && <GroupFix actions={summary?.actions ?? group.actions ?? []} stopped={stopped} run={run} refresh={refresh} />}
          </DetailStatus>
        ) : (
          <Text>—</Text>
        )}
        {importing && <ImportChecks entry={importing} />}
        {importing && unique.length > 0 && <Divider />}
        {unique.length > 0 && (
          <div>
            {unique.length === 1 && releaseEntry ? (
              <ReleaseDetails entryId={releaseEntry.id} release={unique[0]!} />
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
        detail={(number) => <SeasonEpisodes season={number} entries={entries.filter((entry) => entry.season === number)} />}
      />
    </div>
  );
}

// The inspector of a movie: its status and its progress, with the match of a file when the target asks for it.
function MovieDetail({ entry, run, refresh }: { entry: QueueEntryView; run: Run; refresh: () => void }) {
  return (
    <div className="grid gap-3">
      <EntryDetails entry={entry} label={false} fix={<EntryFix entry={entry} run={run} refresh={refresh} />} />
    </div>
  );
}

// The inspector of a series whose episodes load. Its initial job has no target yet, so there is nothing to show.
function PendingDetail() {
  return (
    <div className="grid place-items-center">
      <Spinner label={t('Loading episodes')} />
    </div>
  );
}

// The inspector of the selected title: its name, its menu, and its progress. The body starts again when the selected
// title changes, so a season of the title before does not stay open. The last item of the menu deletes the row from the
// library, with the same modal as the page of the title. A row of a series is one season, so it deletes that season. The
// whole series goes only from the page of the series.
function Inspector({ row, filters, run, refresh, openLogs, openGroupLogs, onDelete, onBack, backRef }: { row: QueueRow; filters: Filters; run: Run; refresh: () => void; openLogs: (entry: QueueEntryView) => void; openGroupLogs: (group: QueueGroupRow) => void; onDelete: (request: PlanRequest, subject: string) => void; onBack: () => void; backRef: Ref<HTMLButtonElement> }) {
  const deletion: { request: PlanRequest; subject: string } | null =
    row.kind === 'entry'
      ? { request: { action: 'remove', keys: [row.titleKey] }, subject: row.title }
      : row.kind === 'group' && row.season !== null
        ? { request: { action: 'remove', keys: [row.titleKey], season: row.season }, subject: seasonName(row.season) }
        : null;
  const items: { label: string; onClick: () => void; danger?: boolean }[] =
    row.kind === 'pending'
      ? []
      : [
          ...(row.kind === 'group' ? groupMenu(row, openGroupLogs, run) : entryMenu(row, run, openLogs)),
          ...(deletion ? [{ label: t('Delete'), danger: true, onClick: () => onDelete(deletion.request, deletion.subject) }] : []),
        ];
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
        <GroupDetail key={`${row.key}|${filters.stage}`} group={row} filters={filters} run={run} refresh={refresh} />
      ) : row.kind === 'pending' ? (
        <PendingDetail />
      ) : (
        <MovieDetail key={`${row.id}|${filters.stage}`} entry={row} run={run} refresh={refresh} />
      )}
    </div>
  );
}

const keys = ['queued', 'searching', 'downloading', 'importing', 'stuck'];

// The stages of the whole page. The row is wide, so it lies above the container of the queue.
function StageMenu({ summary, filters, setFilters }: { summary: QueueSummary | undefined; filters: Filters; setFilters: (f: Filters) => void }) {
  // The server counts rows for each tab, so a badge equals the rows of its tab.
  const counts = summary?.counts ?? {};
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

const numberingText = (numbering: Numbering) => numbering.ranges.map((range) => {
  const episode = (season: number, number: number) => `S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')}`;
  return `${episode(range.season, range.from)}–${episode(range.season, range.to)} → ${episode(range.releaseSeason, range.releaseFrom)}–${episode(range.releaseSeason, range.releaseFrom + range.to - range.from)}`;
}).join(', ') || t('Catalog numbering');

// The question shows in a modal, and the action runs after the second click.
function ConfirmAction({ preview, label = actionLabel[preview.action], onCancel, onConfirm }: { preview: QueueActionPreview; label?: string; onCancel: () => void; onConfirm: () => void }) {
  const count = preview.affected.length;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={count === 1 ? t('{action} 1 target?', { action: t(label) }) : t('{action} {n} targets?', { action: t(label), n: count })}
    >
      {preview.sharedTransfers.map((transfer) => (
        <p key={transfer.name}>
          {t('{name} is one download for {count} targets.', { name: transfer.name, count: transfer.entries })}
        </p>
      ))}
      {preview.action === 'remove_torrent' && <p>{t('The files stay on the disk.')}</p>}
      <ul>
        {preview.affected.slice(0, 20).map((item) => (
          <li key={item.id}>
            {item.label} {statusLabel(item.status)}
          </li>
        ))}
      </ul>
      {preview.affected.length > 20 && <p>{t('And {count} more.', { count: preview.affected.length - 20 })}</p>}
      {preview.unsupported.length > 0 && <p>{t('{count} targets are not changed, because their stage does not fit this action.', { count: preview.unsupported.length })}</p>}
      {preview.numbering?.map((item) => (
        <Details key={item.id} items={[
          { label: t('Target'), value: preview.affected.find((target) => target.id === item.id)?.label ?? item.id },
          { label: t('Current map version'), value: item.from.revision },
          { label: t('New map version'), value: item.to.revision },
          { label: t('Current numbering'), value: numberingText(item.from), wide: true },
          { label: t('New numbering'), value: numberingText(item.to), wide: true },
          { label: t('Continue at'), value: stageLabel(item.phase) },
        ]} />
      ))}
      <ModalActions>
        <Button variant="ghost" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button onClick={onConfirm}>{t(label)}</Button>
      </ModalActions>
    </Modal>
  );
}

const actionLabel: Record<QueueActionName, string> = {
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Try again',
  priority: 'Prioritize',
  unpriority: 'Delete priority from',
  remove_torrent: 'Delete the torrent of',
  replace: 'Replace',
  search_other_seasons: 'Search individually',
  apply_numbering: 'Apply numbering',
  retry_fetch: 'Retry fetch',
  retry_send: 'Retry send',
  check_download: 'Check download',
  retry_import: 'Retry import',
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
  // The inspector opens at the row that the user clicked, so the details land beside that row. Null keeps it at the
  // top of the list, in the flow.
  const listBox = useRef<HTMLDivElement | null>(null);
  const [inspectorTop, setInspectorTop] = useState<number | null>(null);
  // The detail of the first row keeps the top of the list, in the flow, also when the selection falls to it because
  // the selected row left. Any other row moves the details beside its row.
  const detailsTop = chosen !== undefined && chosen === items[0] ? null : inspectorTop;
  // The panel of the inspector, and a count of the clicks on a row. Each click brings the panel into view, also when
  // its content arrives late and it grows after the click.
  const detailsBox = useRef<HTMLDivElement | null>(null);
  const [reveal, setReveal] = useState(0);

  const [preview, setPreview] = useState<{ body: Parameters<typeof send>[0]; data: QueueActionPreview; label?: string } | null>(null);
  const [deletion, setDeletion] = useState<{ request: PlanRequest; subject: string } | null>(null);
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
  // The checks of an import change one by one. The rows read the new state here, without the debounce of `refresh`,
  // so the sequence stays visible.
  useLive('import.checks', (data) => {
    const event = data as { entries?: { id: string; status: QueueEntryView['status']; phase: QueueEntryView['phase']; checks: NonNullable<QueueEntryView['checks']> }[] } | undefined;
    if (!event?.entries?.length) return;
    const updated = new Map(event.entries.map((entry) => [entry.id, entry]));
    const patch = (item: QueueEntryView): QueueEntryView => {
      const change = updated.get(item.id);
      return change ? { ...item, status: change.status, phase: change.phase, checks: change.checks } : item;
    };
    void queryClient.setQueriesData<QueuePage>({ predicate: (query) => String(query.queryKey[0]).startsWith('/queue?') }, (page) =>
      page ? { ...page, items: page.items.map((row) => (row.kind === 'entry' ? { ...row, ...patch(row) } : row)) } : page,
    );
    void queryClient.setQueriesData<QueueGroupPage>({ predicate: (query) => String(query.queryKey[0]).startsWith('/queue/groups/') }, (data) =>
      data ? { ...data, items: data.items.map(patch) } : data,
    );
  });
  // A title that loads its episodes, or leaves the library, changes the pending row of the queue. The job of the
  // title sends its own queue event, so the page needs no timer.
  useLive('library.changed', refresh);

  // The count of the view changes with the filters and with the work. The screen reader hears it, and the focus stays.
  useEffect(() => {
    if (loading) return;
    if (lastCount.current !== null && lastCount.current !== total) setViewNote(total === 1 ? t('1 row in this view') : t('{count} rows in this view', { count: total }));
    lastCount.current = total;
  }, [total, loading]);

  async function send(body: { action: QueueActionName; ids?: string[]; group?: { titleKey: string; season: number | null }; version?: string }) {
    try {
      await api('/queue/actions', { method: 'POST', body });
      refresh();
    } catch (err) {
      refresh();
      setAnnouncement(err instanceof ApiError && err.message === 'client_unreachable' ? t('The download client does not answer. Nothing changed.') : err instanceof ApiError && ['preview_changed', 'numbering_changed', 'mapping_changed'].includes(err.message) ? t('The preview changed. Preview the changes again.') : t('The action did not complete.'));
    }
  }

  // An action on a group, or on a shared download, shows every target that it changes before it starts.
  const run = useCallback(async (action: QueueActionName, ids: string[], group?: { titleKey: string; season: number | null }, label?: string) => {
    const body = group ? { action, group } : { action, ids };
    try {
      const data = await api<QueueActionPreview>('/queue/actions', { method: 'POST', body: { ...body, preview: true } });
      if (data.affected.length === 0) setAnnouncement(t(data.unsupported[0]?.reason ?? 'Nothing to change.'));
      else if (action === 'apply_numbering' || data.affected.length > 1 || data.sharedTransfers.length || group) setPreview({ body: { ...body, ...(data.version ? { version: data.version } : {}) }, data, label });
      else await send({ ...body, ...(data.version ? { version: data.version } : {}) });
    } catch {
      setAnnouncement(t('The action did not complete.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A click on a row selects it. In a narrow window the list goes away, so the inspector shows at once.
  const inspect = (row: QueueRow) => {
    const key = rowKey(row);
    const grid = listBox.current;
    const rowBox = grid ? [...grid.querySelectorAll<HTMLElement>('[data-row]')].find((element) => element.dataset.row === key) : undefined;
    // The inspector opens at the row, wherever the row is, so the details of a row land beside the row that the
    // user clicked.
    if (grid && rowBox) setInspectorTop(Math.round(rowBox.getBoundingClientRect().top - grid.getBoundingClientRect().top));
    setSelected(key);
    setReveal((count) => count + 1);
    if (window.matchMedia(`(max-width: ${NARROW - 1}px)`).matches) setOpen(true);
  };

  // A click on a row moves the page so the panel of the details shows whole, and a panel higher than the window shows
  // from its top. The panel grows when its content arrives, so the resize keeps the page on it until the user scrolls.
  useEffect(() => {
    if (!reveal) return;
    const box = detailsBox.current;
    if (!box) return;
    const show = () => {
      const rect = box.getBoundingClientRect();
      const view = document.documentElement.clientHeight;
      const top = rect.height >= view ? 0 : Math.min(Math.max(rect.top, 0), view - rect.height);
      if (Math.abs(rect.top - top) >= 1) window.scrollBy(0, rect.top - top);
    };
    const observer = new ResizeObserver(show);
    observer.observe(box);
    show();
    const stop = () => {
      observer.disconnect();
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('keydown', stop);
    return stop;
  }, [reveal]);

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
    setInspectorTop(null);
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
          <FinishedPanel />
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
        <div ref={listBox} className="grid gap-6 min-[800px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] min-[800px]:items-start">
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
          {/* The inspector keeps the top of the list, in the flow, for the first row. A click on a row below the first
              takes it out of the flow and opens it at that row, so the detail lands beside it. */}
          <div className={`min-w-0 min-[800px]:relative ${open ? '' : 'max-[800px]:hidden'}`}>
            <div className={`grid gap-6 ${detailsTop === null ? '' : 'min-[800px]:absolute min-[800px]:inset-x-0'}`} style={detailsTop === null ? undefined : { top: detailsTop }}>
              {chosen ? (
                <>
                  <div ref={detailsBox} className="w-full">
                    <Pane className="w-full">
                      <Inspector row={chosen} filters={filters} run={run} refresh={refresh} openLogs={setLogs} openGroupLogs={setGroupLogs} onDelete={(request, subject) => setDeletion({ request, subject })} onBack={back} backRef={backButton} />
                    </Pane>
                  </div>
                  {chosen.kind === 'group' ? (
                    <GroupRejected group={chosen} filters={filters} refresh={refresh} />
                  ) : chosen.kind === 'entry' ? (
                    <MovieRejected entry={chosen} refresh={refresh} />
                  ) : null}
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
          label={preview.label}
          onCancel={() => setPreview(null)}
          onConfirm={() => {
            const body = preview.body;
            setPreview(null);
            void send(body);
          }}
        />
      )}
      {deletion && <PlanDialog request={deletion.request} subject={deletion.subject} deleteFilesDefault onClose={() => setDeletion(null)} onDone={() => refresh()} />}
    </div>
  );
}

export function Activity() {
  return <QueueView />;
}
