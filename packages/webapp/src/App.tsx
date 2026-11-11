import type { PresetRow, QueueRow, QueueSummary, RootRow, SettingsData } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Activity as ActivityLine, Background, Navbar, Pane, SearchField, Spinner } from 'nebula';
import { Check, Pause } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useHref, useLocation, useNavigate } from 'react-router';
import { AuthGate } from './pages/auth/auth.tsx';
import { AlertsFeed, AlertsIcon, CatalogIcon, LoadFailed, SettingsIcon } from './components/index.ts';
import { Alerts } from './pages/alerts/alerts.tsx';
import { Library } from './pages/library/library.tsx';
import { Activity } from './pages/activity/activity.tsx';
import { SearchPage } from './pages/search/search.tsx';
import { Settings } from './pages/settings/settings.tsx';
import { Setup } from './pages/setup/setup.tsx';
import { groupName, stageLabel } from './lib/format.ts';
import { jobAction } from './lib/job.ts';
import { setLanguage, t, useLanguage } from './i18n/index.ts';
import { useLive } from './lib/live.ts';
import logo from './assets/logo.svg';

// The menu. Activity is not in it: the queue status at the start of the navbar opens that page.
const sections = [
  { path: '/catalog', label: 'Catalog', icon: <CatalogIcon />, page: <Library /> },
  { path: '/settings', label: 'Settings', icon: <SettingsIcon />, page: <Settings /> },
  { path: '/alerts', label: '', icon: <AlertsIcon />, page: <Alerts /> },
];

// The stages that mean work for the queue. The active stages come first, so a long download does not hide
// the work that changes. The search comes before the fetch of its release, because the fetch belongs to it.
// Downloading is last: the line shows it only when no other stage runs.
const WORKING = ['importing', 'validating', 'sending', 'searching', 'fetching', 'queued', 'downloading'];

// The name of the task as the Activity page shows it: a season of a series, or a movie.
const taskName = (row: QueueRow) => (row.kind === 'group' ? groupName(row) : row.label);

// The task that runs now is the job of the worker. Work without a job, such as a download, names the first target of its stage.
function QueueStatus({ href, onOpen }: { href: string; onOpen: () => void }) {
  // The line follows the job that runs now, and a download that runs without a job. The summary reads again while
  // a job runs, so the line drops the job at its end when the queue sends no event.
  const summary = useQuery<QueueSummary>({ queryKey: ['/queue/summary'], refetchInterval: (query) => (query.state.data?.currentJob ? 2_000 : false) });
  const job = summary.data?.currentJob;
  const stage = WORKING.find((key) => summary.data?.working[key]);
  // Fetching shows in the Searching view, so its row comes from the same list.
  const listKey = stage === 'fetching' ? 'searching' : stage;
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
    if (summary.data.stopped) return <ActivityLine status={t('All items in queue are stuck')} alert href={href} onClick={onOpen} />;
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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // The links point inside the URL base of the app, so a new tab opens the right page.
  const base = useHref('/').replace(/\/$/, '');
  const [query, setQuery] = useState('');
  // A search starts while the person types. It opens at once with Enter, and after the pause with a letter.
  // On the results page each new search replaces the address, so Back leaves the search in one step.
  const search = (value: string) => {
    const text = value.trim();
    if (!text) return;
    const onResults = window.location.pathname.startsWith(`${base}/search`);
    void navigate(`/search?q=${encodeURIComponent(text)}`, { replace: onResults });
  };
  useEffect(() => {
    if (!query.trim()) return;
    const timer = setTimeout(() => search(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const onActivity = pathname.startsWith('/activity');
  // No menu link is selected on the Activity page, or on the Alerts page, whose item is an icon only.
  const selected = onActivity || pathname.startsWith('/alerts') ? '' : (sections.find((s) => pathname.startsWith(s.path))?.path ?? '/catalog');

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
          value={query}
          onChange={setQuery}
          onSubmit={search}
          placeholder={t('Search...')}
        />
      </Navbar>
      {/* flow-root keeps the bottom margin of the last section inside the background. The bottom margin holds the space of the alerts, so the last content goes above them when the page scrolls to the end. */}
      <main className="flow-root mb-48">
        <Routes>
          <Route path="/search" element={<SearchPage />} />
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
  if (!settings.data || !roots.data) return <Spinner label={t('Loading')} />;
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
