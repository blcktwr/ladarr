import type { PresetRow, QueueRow, QueueSummary, RootRow, SettingsData } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Activity as ActivityLine, Background, Navbar, Pane, SearchField, Spinner } from 'nebula';
import { Check, Compass, Pause } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useHref, useLocation, useNavigate } from 'react-router';
import { AuthGate } from './pages/auth/auth.tsx';
import { AlertsFeed, AlertsIcon, CatalogIcon, LoadFailed, SettingsIcon } from './components/index.ts';
import { Alerts } from './pages/alerts/alerts.tsx';
import { Discovery } from './pages/discovery/discovery.tsx';
import { Library } from './pages/library/library.tsx';
import { Activity } from './pages/activity/activity.tsx';
import { Settings } from './pages/settings/settings.tsx';
import { Setup } from './pages/setup/setup.tsx';
import { groupName, stageLabel } from './lib/format.ts';
import { jobAction } from './lib/job.ts';
import { setLanguage, t, useLanguage } from './i18n/index.ts';
import { useLive } from './lib/live.ts';
import logo from './assets/logo.svg';

// The menu. Activity is not in it: the queue status at the start of the navbar opens that page.
const sections = [
  { path: '/discovery', label: 'Discovery', icon: <Compass />, page: <Discovery /> },
  { path: '/catalog', label: 'Catalog', icon: <CatalogIcon />, page: <Library /> },
  { path: '/settings', label: 'Settings', icon: <SettingsIcon />, page: <Settings /> },
  { path: '/alerts', label: '', icon: <AlertsIcon />, page: <Alerts /> },
];

// The page of a title opens under the address of the catalog.
const titlePage = /^\/catalog\/(movie|tv)\/\d+\/?$/;

// The stages that mean work for the queue. The active stages come first, so a long download does not hide
// the work that changes. The search comes before the fetch of its release, because the fetch belongs to it.
// Downloading is last: the line shows it only when no other stage runs.
const WORKING = ['importing', 'waiting_slot', 'sending', 'searching', 'fetching', 'queued', 'downloading'];

// The name of the task as the Activity page shows it: a season of a series, a movie, or a series that loads its episodes.
const taskName = (row: QueueRow) => (row.kind === 'entry' ? row.label : groupName(row));

// The task that runs now is the job of the worker. Work without a job, such as a download, names the first target of its stage.
function QueueStatus({ href, onOpen }: { href: string; onOpen: () => void }) {
  // The line follows the job that runs now, and a download that runs without a job. The summary reads again while
  // a job runs, so the line drops the job at its end when the queue sends no event.
  const summary = useQuery<QueueSummary>({ queryKey: ['/queue/summary'], refetchInterval: (query) => (query.state.data?.currentJob ? 2_000 : false) });
  const job = summary.data?.currentJob;
  const stage = WORKING.find((key) => summary.data?.working[key]);
  // Fetching shows in the Searching view, and the wait for a slot in the Downloading view, so the row comes from that list.
  const listKey = stage === 'fetching' ? 'searching' : stage === 'waiting_slot' ? 'downloading' : stage;
  const current = useQuery<{ items: QueueRow[] }>({ queryKey: [`/queue?stage=${listKey}&limit=1`], enabled: Boolean(stage) && !job });
  useLive('queue.changed', () => {
    void summary.refetch();
    if (!job && stage) void current.refetch();
  });
  // A new indexer or client can start a target that stopped, so the line reads the setup changes too.
  useLive('indexers.changed', () => void summary.refetch());
  useLive('clients.changed', () => void summary.refetch());
  // The line is the only way to the queue, so it shows while the summary loads, and when the summary fails.
  if (!summary.data) return <ActivityLine status={t('Queue')} href={href} onClick={onOpen} />;
  // The queue cannot search or download without an indexer and a client.
  if (!summary.data.indexers || !summary.data.hasClient) return <ActivityLine status={t('Download client required')} alert href={href} onClick={onOpen} />;
  // The user paused the queue, so the work waits.
  if (summary.data.paused) return <ActivityLine status={t('Paused')} state={{ icon: <Pause /> }} href={href} onClick={onOpen} />;
  // The job that the worker runs now is the current work, also when its target is not the first row of the page.
  if (job) return <ActivityLine status={jobAction(job.type, true)} task={job.label ?? undefined} href={href} onClick={onOpen} />;
  if (!stage) {
    // A target that stopped on a reason waits for the person, so the line does not say that all is done.
    const count = summary.data.stopped;
    if (count) {
      const status = count === 1 ? t('1 item in queue is stuck') : t('{count} items in queue are stuck', { count });
      return <ActivityLine status={status} alert href={href} onClick={onOpen} />;
    }
    // The user paused targets, so their work waits.
    if (summary.data.counts.paused) return <ActivityLine status={t('Paused')} state={{ icon: <Pause /> }} href={href} onClick={onOpen} />;
    return <ActivityLine status={t('All caught up')} state={{ icon: <Check /> }} href={href} onClick={onOpen} />;
  }
  const row = current.data?.items[0];
  return <ActivityLine status={stageLabel(stage)} task={row && taskName(row)} href={href} onClick={onOpen} />;
}

// The pause after the last letter, before the search starts. It joins the letters of a word into one request.
const SEARCH_DELAY_MS = 300;

function Shell() {
  const { pathname, search: locationSearch, hash } = useLocation();
  const navigate = useNavigate();
  // The links point inside the URL base of the app, so a new tab opens the right page.
  const base = useHref('/').replace(/\/$/, '');
  const onDiscovery = pathname === '/discovery' || pathname === '/discovery/';
  const term = onDiscovery ? new URLSearchParams(locationSearch).get('q')?.trim() ?? '' : '';
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    setDraft((value) => onDiscovery && value?.trim() === term ? value : null);
  }, [onDiscovery, pathname, term]);
  const search = useCallback((value: string) => {
    const text = value.trim();
    if (text === term) return;
    const params = new URLSearchParams(onDiscovery ? locationSearch : '');
    if (text) params.set('q', text);
    else params.delete('q');
    void navigate({ pathname: '/discovery', search: params.toString() }, { replace: Boolean(term) });
  }, [term, onDiscovery, locationSearch, navigate]);
  useEffect(() => {
    if (draft === null) return;
    const timer = setTimeout(() => search(draft), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, search]);
  const onActivity = pathname.startsWith('/activity');
  // The page of a title has the address of the catalog, whatever section opened it, so the menu keeps the section that
  // the person was on while the page is open.
  const onTitle = titlePage.test(pathname);
  const section = onTitle ? undefined : sections.find((s) => pathname.startsWith(s.path))?.path;
  const lastSection = useRef('/catalog');
  useEffect(() => {
    if (section && section !== '/alerts') lastSection.current = section;
  }, [section]);
  const selected = onActivity || pathname.startsWith('/alerts') ? '' : (section ?? (onTitle ? lastSection.current : '/catalog'));

  return (
    <>
      <AlertsFeed />
      <Navbar
        aria-label={t('Sections')}
        logo={<img src={logo} alt="Ladarr" width={32} height={32} />}
        items={sections.map((s) => ({ value: s.path, label: t(s.label), icon: s.icon, href: base + s.path }))}
        value={selected}
        onChange={(value) => void navigate(value)}
        start={<QueueStatus href={base + '/activity'} onOpen={() => void navigate('/activity')} />}
      >
        <SearchField
          aria-label={t('Search')}
          value={draft ?? term}
          onChange={setDraft}
          onSubmit={search}
          placeholder={t('Search...')}
        />
      </Navbar>
      {/* flow-root keeps the bottom margin of the last section inside the background. The bottom margin holds the space of the alerts, so the last content goes above them when the page scrolls to the end. */}
      <main className="flow-root mb-48">
        <Routes>
          <Route path="/search" element={<Navigate to={{ pathname: '/discovery', search: locationSearch, hash }} replace />} />
          <Route path="/activity/*" element={<Activity />} />
          {sections.map((s) => (
            <Route key={s.path} path={`${s.path}/*`} element={s.page} />
          ))}
          <Route path="*" element={<Navigate to="/catalog" replace />} />
        </Routes>
      </main>
    </>
  );
}

// The app opens after the setup saved the folders and the quality preset.
function SetupGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const settings = useQuery<{ settings: SettingsData; presets: PresetRow[] }>({ queryKey: ['/settings'] });
  const roots = useQuery<{ roots: RootRow[] }>({ queryKey: ['/roots'] });
  const language = settings.data?.settings.language;
  useEffect(() => {
    if (language) setLanguage(language);
  }, [language]);
  // The theme of nebula is the data-theme of the page. Dark is the base, so the attribute can wait for the settings.
  const theme = settings.data?.settings.theme;
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
  }, [theme]);
  const reload = () => {
    void settings.refetch();
    void roots.refetch();
  };
  if ((settings.error && !settings.data) || (roots.error && !roots.data)) {
    return (
      <Pane>
        <LoadFailed onRetry={reload} />
      </Pane>
    );
  }
  if (!settings.data || !roots.data) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label={t('Loading')} />
      </div>
    );
  }
  if (!settings.data.settings.setupCompleted) {
    // The setup runs at its own address, so the catalog never shows before the setup is complete.
    if (pathname !== '/setup') return <Navigate to="/setup" replace />;
    return <Setup data={{ settings: settings.data.settings, roots: roots.data.roots }} onDone={reload} />;
  }
  if (pathname === '/setup') return <Navigate to="/catalog" replace />;
  return children;
}

export function App() {
  // A new language starts the whole tree again, so every text uses it.
  const language = useLanguage();
  return (
    <Background key={language}>
      <AuthGate>
        <SetupGate>
          <Shell />
        </SetupGate>
      </AuthGate>
    </Background>
  );
}
