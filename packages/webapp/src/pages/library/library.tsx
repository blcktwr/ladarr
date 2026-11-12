import type { LibraryType } from '@ladarr/shared/enums';
import type { CastMember, EpisodeRow, EpisodeSummary, PersonCredits, PlanRequest, SearchPlan, SearchResult, SeasonRow, SeriesEpisodes, TitleDetail, TitlePreview, TitleSummary, UpgradeQuality } from '@ladarr/shared/types';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { Link as RouterLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../../lib/api.ts';
import { ResultItem } from '../search/result-item.tsx';
import { Actions, ActionMenu, Backdrop, Badge, Button, Checkbox, Dropdown, EmptyState, Gallery, Modal, Pane, Section, Spinner, SubMenu, Table, Text, Thumbnail } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { Link, LoadFailed, LoadingGallery, pageWidth } from '../../components/index.ts';
import { ModalActions } from '../../components/modal-actions.tsx';
import { catalogPath, contentType, posterUrl, describeError, shownKey, statusLabel } from '../../lib/format.ts';
import { t, getLanguage } from '../../i18n/index.ts';
import { useLive } from '../../lib/live.ts';
import { StatusText } from '../../lib/status.tsx';
import { useQueueNotice } from '../../lib/queue-notice.ts';
import imdbLogo from '../../assets/imdb-logo.svg';
import tmdbLogo from '../../assets/tmdb-logo.svg';
import { BulkActions, PlanDialog, useSelection } from './library-bulk.tsx';
import { AddManuallyDialog, ImportBackupDialog } from './catalog-import.tsx';
import { UntitledFolders } from './library-folders.tsx';

type Target = { titleKey: string; season?: number; number?: number };

const PAGE_SIZE = 48;
// The title page keeps the margins of the app. The thumbnails lie on the page with no pane.
const column = `grid gap-8 ${pageWidth}`;
// The catalog has the margins of the app.
const catalog = 'grid gap-8 p-6';
// The title of the catalog has a centered column, and its content aligns at its left edge.
const catalogColumn = 'mx-auto w-[min(1200px,calc(100%-40px))]';
// The thumbnails of the catalog span the window. The column is as wide as the columns of thumbnails that fit in it,
// so the room that a column does not fill goes in equal parts to each side (10rem per thumbnail and 1.5rem between
// them).
const catalogTiles = 'mx-auto w-[calc(round(down,calc(100%+1.5rem),11.5rem)-1.5rem)]';

function TitlePoster({ title, selected, onSelectedChange }: { title: TitleSummary; selected: boolean; onSelectedChange: (selected: boolean) => void }) {
  return (
    <RouterLink to={catalogPath(title.key)}>
      <Thumbnail
        image={posterUrl(title.posterPath, 'w342') ?? ''}
        title={title.title}
        type={contentType(title.mediaType, title.seriesType)}
        noCaption
        selected={selected}
        onSelectedChange={onSelectedChange}
        dimmed={title.availability === 'waiting'}
      />
    </RouterLink>
  );
}

function LibraryList() {
  const [type, setType] = useState<'all' | LibraryType>('all');
  const selection = useSelection();
  const [removal, setRemoval] = useState<PlanRequest | null>(null);
  const [importing, setImporting] = useState(false);
  const [addingManually, setAddingManually] = useState(false);
  const { data, error, isFetching: loading, isFetchingNextPage, refetch: reload, fetchNextPage, hasNextPage } = useInfiniteQuery({
    queryKey: ['/library', type],
    queryFn: ({ pageParam }) => api<{ items: TitleSummary[]; total: number }>(`/library?limit=${PAGE_SIZE}&offset=${pageParam}${type === 'all' ? '' : `&type=${type}`}`),
    initialPageParam: 0,
    // The next page starts after the titles that the gallery has.
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages.at(-1)?.total ?? 0;
  // The end of the gallery takes the next page before it reaches the screen.
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = more.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage && !error) void fetchNextPage();
    }, { rootMargin: '600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [error, fetchNextPage, hasNextPage, isFetchingNextPage]);
  useLive('library.changed', () => void reload());

  if (error && !data) {
    return (
      <div className={catalog}>
        <div className={catalogColumn}>
          <Text variant="title">{t('Catalog')}</Text>
        </div>
        <LoadFailed onRetry={reload} />
      </div>
    );
  }
  if (loading && !data) {
    return (
      <div className={catalog}>
        <div className={catalogColumn}>
          <Text variant="title">{t('Catalog')}</Text>
        </div>
        <div className={catalogTiles}>
          <LoadingGallery />
        </div>
      </div>
    );
  }
  // With no title in the catalog, the type menu has nothing to act on.
  const catalogEmpty = total === 0 && type === 'all';

  return (
    <div className={catalog}>
      <div className={`${catalogColumn} flex flex-wrap items-center justify-between gap-4`}>
        <Text variant="title">{t('Catalog')}</Text>
        <Actions>
          <BulkActions selection={selection} onRemove={setRemoval} />
          {!catalogEmpty && (
            <SubMenu
              aria-label={t('Type')}
              value={type}
              onValueChange={(key) => {
                setType(key as typeof type);
              }}
              items={[
                { value: 'all', label: t('All') },
                { value: 'movie', label: t('Movies') },
                { value: 'tv', label: t('Series') },
              ]}
            />
          )}
          <ActionMenu label={t('More actions')} items={[{ label: t('Import'), onClick: () => setImporting(true) }, { label: t('Add manually'), onClick: () => setAddingManually(true) }]} />
        </Actions>
      </div>
      <ImportBackupDialog open={importing} onClose={() => setImporting(false)} />
      <AddManuallyDialog open={addingManually} onClose={() => setAddingManually(false)} />
      <PlanDialog request={removal} onClose={() => setRemoval(null)} onDone={() => selection.clear()} />
      {items.length === 0 ? (
        <EmptyState>{type === 'all' ? t('Your catalog is empty. Search for a title to add it.') : t('No titles of this type.')}</EmptyState>
      ) : (
        <div className={catalogTiles}>
          <Gallery>
            {items.map((title) => (
              <Actions key={title.key}>
                <TitlePoster title={title} selected={selection.has(title.key)} onSelectedChange={() => selection.toggle(title.key)} />
              </Actions>
            ))}
          </Gallery>
        </div>
      )}
      {hasNextPage && <div ref={more} aria-hidden="true" className="h-px" />}
    </div>
  );
}

// Puts the target in the queue and starts the search. Activity shows the work.
async function search(body: Target) {
  const { started } = await api<{ started: string[] }>('/queue/search', { method: 'POST', body });
  if (!started.length) throw new ApiError(409, 'nothing_to_search');
  return started.length;
}

// The Upgrade button of a title page. The dialog offers the qualities that the profile chain defines above a file.
// The user picks one, and ladarr searches the files below it for a release of exactly that quality.
function UpgradeDialog({ titleKey, qualities, error }: { titleKey: string; qualities?: UpgradeQuality[]; error?: unknown }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const queueNotice = useQueueNotice();
  const id = useId();
  const options = qualities ?? [];
  // With no quality left, the button is disabled and says why. A read that failed keeps it enabled, so the dialog shows the error.
  const empty = qualities !== undefined && options.length === 0;
  const selected = options.some((option) => option.id === choice) ? choice : (options[0]?.id ?? '');

  async function start() {
    if (!selected) return;
    setMessage('');
    setPending(true);
    try {
      const plan = await api<SearchPlan>('/library/search/preview', { method: 'POST', body: { kind: 'upgrades', keys: [titleKey], quality: selected } });
      if (!plan.planId) throw new ApiError(409, 'nothing_to_search');
      await api('/library/search', { method: 'POST', body: { planId: plan.planId } });
      queueNotice(plan.targets);
      setOpen(false);
    } catch (err) {
      setMessage(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setMessage('');
      }}
      title={t('Search for upgrades')}
      trigger={
        <span title={empty ? t('You already have the latest quality.') : undefined}>
          <Button variant="ghost" disabled={empty}>
            {t('Upgrade')}
          </Button>
        </span>
      }
    >
      {message && <Alert tone="danger">{message}</Alert>}
      {error != null && !qualities && <Alert tone="danger">{describeError(error)}</Alert>}
      {options.length > 0 && (
        <>
          <label htmlFor={id}>{t('Quality')}</label>
          <Dropdown id={id} value={selected} options={options.map((option) => ({ value: option.id, label: option.label }))} onValueChange={(value) => setChoice(value ?? '')} />
        </>
      )}
      <ModalActions>
        {options.length > 0 ? (
          <>
            <Button variant="ghost" autoFocus onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button pending={pending} onClick={() => void start()}>
              {t('Search')}
            </Button>
          </>
        ) : (
          <Button autoFocus onClick={() => setOpen(false)}>
            {t('Close')}
          </Button>
        )}
      </ModalActions>
    </Modal>
  );
}

type EpisodeItem = EpisodeSummary & { hasFile?: boolean; queue?: string | null; monitored?: boolean };

const seasonName = (seasonNumber: number) => (seasonNumber === 0 ? t('Specials') : t('Season {n}', { n: seasonNumber }));

// The specials come after the seasons, not before them.
const seasonOrder = <T extends { seasonNumber: number }>(seasons: T[]) =>
  [...seasons].sort((a, b) => (a.seasonNumber === 0 ? Infinity : a.seasonNumber) - (b.seasonNumber === 0 ? Infinity : b.seasonNumber));

// The status of an episode comes from its target in the queue. An episode that the queue never had is Available
// when it has a file, and Searching until a release is found otherwise. An episode without monitoring shows N/A,
// because nothing searches for it.
function EpisodeStatus({ episode }: { episode: EpisodeItem }) {
  if (episode.queue) {
    const key = shownKey(episode.queue);
    return <StatusText small status={statusLabel(key)} icon={key} />;
  }
  if (episode.hasFile) return <StatusText small status={statusLabel('available')} icon="available" />;
  if (episode.monitored === false) return <Text variant="small">{t('N/A')}</Text>;
  return <StatusText small status={statusLabel('searching')} icon="searching" />;
}

// The table of the episodes of a season. A series in the library shows the status of each episode. A series that is not in it shows the facts only.
function EpisodeTable({ rows, loading = false, library = false }: { rows?: EpisodeItem[]; loading?: boolean; library?: boolean }) {
  const airDate = (date: string) => {
    const [year, month, day] = date.split('-');
    return `${day}/${month}/${year}`;
  };
  return (
    <Table
      aria-label={t('Episodes')}
      loading={loading}
      columns={[
        { label: '#', width: '6rem' },
        { label: t('Title'), width: '24rem' },
        { label: t('Air date'), width: '8rem' },
        ...(library ? [{ label: t('Status'), width: '9rem' }] : []),
      ]}
      rows={rows?.map((row, index) => ({
        key: `${row.season}x${row.number}`,
        cells: [
          `${index + 1} (${row.number})`,
          row.name,
          row.airDate ? airDate(row.airDate) : t('Unknown'),
          ...(library ? [<EpisodeStatus key="status" episode={row} />] : []),
        ],
      }))}
    />
  );
}

// The table of the episodes of a season of a series in the library.
function LibrarySeason({ titleKey, season }: { titleKey: string; season: number }) {
  const { data, error, refetch: reload } = useQuery<{ episodes: EpisodeRow[] }>({ queryKey: [`/library/${titleKey}/episodes?season=${season}`] });
  useLive('library.changed', () => void reload());
  useLive('queue.changed', () => void reload());

  if (error && !data) return <LoadFailed onRetry={reload} />;
  if (data && data.episodes.length === 0) return <EmptyState>{t('No episodes.')}</EmptyState>;
  return <EpisodeTable rows={data?.episodes} loading={!data} library />;
}

// A season of the series in its own container. A click on the container opens and closes the table of episodes. The
// buttons at the right do the same for the keyboard, and the first one adds the season before the series is in the
// library. A click inside the table does not close it.
function SeasonPane({ name, expanded, onToggle, add, children }: { name: string; expanded: boolean; onToggle: () => void; add?: ReactNode; children?: ReactNode }) {
  const click = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('table, button')) return;
    onToggle();
  };
  return (
    <div className="cursor-pointer" onClick={click}>
      <Pane className="w-full">
        <Section
          title={name}
          action={
            <>
              {add}
              <Button iconOnly variant="ghost" aria-label={expanded ? t('Hide episodes of {name}', { name }) : t('Show episodes of {name}', { name })} onClick={onToggle}>
                {expanded ? <ChevronUp /> : <ChevronDown />}
              </Button>
            </>
          }
        >
          {children && <div className="w-full cursor-default">{children}</div>}
        </Section>
      </Pane>
    </div>
  );
}

// A season is selected for download when it has at least one monitored episode.
const seasonSelected = (season: SeasonRow) => season.counts.eligible + season.counts.upcoming > 0;

// Each season is a container that opens and closes. All of them start closed. The button on a container opens the
// table of its episodes. A season that is not selected has a + that selects it, and a selected season has a trash that
// removes it.
function Seasons({ title, onAddSeason, onRemoveSeason }: { title: TitleDetail; onAddSeason: (season: number) => void; onRemoveSeason: (season: number) => void }) {
  const [open, setOpen] = useState<Set<number> | null>(null);
  if (title.episodesLoadedAt === null) {
    return (
      <Pane className="w-full">
        <Spinner label={t('Loading episodes')} />
      </Pane>
    );
  }
  const seasons = seasonOrder(title.seasons.filter((season) => season.counts.total > 0));
  if (seasons.length === 0) {
    return (
      <Pane className="w-full">
        <EmptyState>{t('No episodes.')}</EmptyState>
      </Pane>
    );
  }
  const shown = open ?? new Set<number>();
  const toggle = (season: number) =>
    setOpen((current) => {
      const next = new Set(current ?? []);
      if (next.has(season)) next.delete(season);
      else next.add(season);
      return next;
    });
  return seasons.map((season) => {
    const expanded = shown.has(season.seasonNumber);
    return (
      <SeasonPane
        key={season.seasonNumber}
        name={seasonName(season.seasonNumber)}
        expanded={expanded}
        onToggle={() => toggle(season.seasonNumber)}
        add={
          seasonSelected(season) ? (
            <Button iconOnly variant="danger" aria-label={t('Delete {season}', { season: seasonName(season.seasonNumber) })} onClick={() => onRemoveSeason(season.seasonNumber)}>
              <Trash2 />
            </Button>
          ) : (
            <Button iconOnly variant="ghost" aria-label={t('Add {season}', { season: seasonName(season.seasonNumber) })} onClick={() => onAddSeason(season.seasonNumber)}>
              <Plus />
            </Button>
          )
        }
      >
        {expanded && <LibrarySeason titleKey={title.key} season={season.seasonNumber} />}
      </SeasonPane>
    );
  });
}

// The seasons of a series that is not in the library come from TMDB. They show when the user opens the page, before any search.
function PreviewSeasons({ tmdbId, onAddSeason, pending }: { tmdbId: number; onAddSeason: (season: number) => void; pending: { season: number | null } | null }) {
  const { data, error, refetch: reload } = useQuery<SeriesEpisodes>({ queryKey: [`/search/tv/${tmdbId}/seasons`] });
  const [open, setOpen] = useState<Set<number> | null>(null);
  const seasons = seasonOrder((data?.seasons ?? []).filter((season) => season.episodes.length > 0));
  if (error && !data) {
    return (
      <Pane className="w-full">
        <LoadFailed onRetry={reload} />
      </Pane>
    );
  }
  if (!data) {
    return (
      <Pane className="w-full">
        <Spinner label={t('Loading episodes')} />
      </Pane>
    );
  }
  if (seasons.length === 0) {
    return (
      <Pane className="w-full">
        <EmptyState>{t('No episodes.')}</EmptyState>
      </Pane>
    );
  }
  const shown = open ?? new Set<number>();
  const toggle = (season: number) =>
    setOpen((current) => {
      const next = new Set(current ?? []);
      if (next.has(season)) next.delete(season);
      else next.add(season);
      return next;
    });
  return seasons.map((season) => {
    const expanded = shown.has(season.seasonNumber);
    return (
      <SeasonPane
        key={season.seasonNumber}
        name={seasonName(season.seasonNumber)}
        expanded={expanded}
        onToggle={() => toggle(season.seasonNumber)}
        add={
          pending && pending.season === season.seasonNumber ? (
            <Button iconOnly variant="ghost" disabled aria-label={t('Loading episodes')}>
              <Spinner size="sm" label={t('Loading episodes')} />
            </Button>
          ) : (
            <Button iconOnly variant="ghost" disabled={Boolean(pending)} aria-label={t('Add {season}', { season: seasonName(season.seasonNumber) })} onClick={() => onAddSeason(season.seasonNumber)}>
              <Plus />
            </Button>
          )
        }
      >
        {expanded && <EpisodeTable rows={season.episodes} />}
      </SeasonPane>
    );
  });
}

// The facts that the header of a title shows. A title in the library and a title that is not in it both have them.
type Header = { title: string; year: number | null; overview: string; posterPath: string | null; backdropPath: string | null; rating: number | null; runtime: number | null; imdbId: string | null; tvdbId: number | null; date: string | null };

// The row over the backdrop: the back button, and at the right the button that adds the title or the buttons of its actions.
function Controls({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  // A page that the user opens first has no page before it in the app, so Back opens the catalog.
  const first = useLocation().key === 'default';
  return (
    <div className="flex items-center justify-between gap-4 mb-4">
      <Button iconOnly aria-label={t('Back')} onClick={() => (first ? void navigate('/catalog') : void navigate(-1))}>
        <ArrowLeft />
      </Button>
      {children}
    </div>
  );
}

// The logos open the title on IMDb and TMDB. The rating of TMDB shows with its logo.
function TitleLinks({ imdbId, tmdbId, mediaType, rating }: { imdbId: string | null; tmdbId: number; mediaType: string; rating: number | null }) {
  return (
    <div className="flex items-center gap-6">
      <a href={`https://www.themoviedb.org/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}`} target="_blank" rel="noreferrer" className="flex items-center gap-2">
        <img src={tmdbLogo} alt="TMDB" className="h-[9.8px] w-auto" />
        {rating !== null && <Badge>{rating.toFixed(1)}</Badge>}
      </a>
      {imdbId !== null && (
        <a href={`https://www.imdb.com/title/${imdbId}/`} target="_blank" rel="noreferrer">
          <img src={imdbLogo} alt="IMDb" className="h-5 w-auto" />
        </a>
      )}
    </div>
  );
}

// A TMDB date is a day with no time zone. UTC keeps the browser from moving it to the day before.
const formatDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(getLanguage(), { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

// The hero of a title has one shape for a movie and for a series. The parts below it are the ones that differ.
// The children are the extra facts of a person. A photo of a person is not a poster, so it has its own size.
function TitleHeader({ header, posterSize = 'w342', mediaType, tmdbId, resolutions, controls, children }: { header: Header; posterSize?: 'w342' | 'h632'; mediaType?: string; tmdbId?: number; resolutions?: number[]; controls?: ReactNode; children?: ReactNode }) {
  return (
    <div className={pageWidth}>
      <Controls>{controls}</Controls>
      <Backdrop image={posterUrl(header.backdropPath, 'w1280') ?? ''}>
        {/* The header has the title and the year, so the poster has no title and no year. */}
        {/* The empty caption leaves 16 px under the poster. The margin takes them back, so the poster is at the center of the backdrop. */}
        <div className="-mb-4">
          <Thumbnail size="lg" image={posterUrl(header.posterPath, posterSize) ?? ''} title="" year="" />
        </div>
        <div className="grid gap-3 grow basis-64 min-w-0 self-center">
          <Text variant="title">{`${header.title}${header.year ? ` (${header.year})` : ''}`}</Text>
          {header.date && <Text variant="small">{formatDate(header.date)}</Text>}
          {header.overview && <Text>{header.overview}</Text>}
          {mediaType !== undefined && tmdbId !== undefined && <TitleLinks imdbId={header.imdbId} tmdbId={tmdbId} mediaType={mediaType} rating={header.rating} />}
          {resolutions && resolutions.length > 0 && (
            <div className="flex items-center gap-2">
              {resolutions.map((resolution) => (
                <Badge key={resolution}>{`${resolution}p`}</Badge>
              ))}
            </div>
          )}
          {children && <Actions>{children}</Actions>}
        </div>
      </Backdrop>
    </div>
  );
}

function TitleHeaderLoading() {
  return (
    <div className={pageWidth}>
      <Controls />
      <Backdrop loading>
        <Thumbnail size="lg" loading />
        <div className="grid gap-3 grow basis-64 min-w-0 self-center">
          <Text variant="title" loading />
          <Text loading />
        </div>
      </Backdrop>
    </div>
  );
}

// The cast and the recommendations come from TMDB. A section shows only when TMDB sends something for it.
function TitleExtras({ mediaType, tmdbId }: { mediaType: string; tmdbId: string }) {
  const cast = useQuery<{ cast: CastMember[] }>({ queryKey: [`/search/${mediaType}/${tmdbId}/cast`] });
  const recommendations = useQuery<{ results: SearchResult[] }>({ queryKey: [`/search/${mediaType}/${tmdbId}/recommendations`] });
  return (
    <div className={column}>
      {cast.isPending && (
        <Section title={t('Cast')}>
          <LoadingGallery size="sm" count={6} />
        </Section>
      )}
      {cast.data && cast.data.cast.length > 0 && (
        <Section title={t('Cast')}>
          <Gallery>
            {cast.data.cast.map((person) => (
              <RouterLink key={person.id} to={`/catalog/person/${person.id}`}>
                <Thumbnail size="sm" image={posterUrl(person.profilePath) ?? ''} title={person.name} year={person.character} />
              </RouterLink>
            ))}
          </Gallery>
        </Section>
      )}
      {recommendations.isPending && (
        <Section title={t('Recommendations')}>
          <LoadingGallery size="sm" count={6} />
        </Section>
      )}
      {recommendations.data && recommendations.data.results.length > 0 && (
        <Section title={t('Recommendations')}>
          <Gallery>
            {recommendations.data.results.map((result) => (
              <ResultItem key={result.tmdbId} result={result} size="sm" />
            ))}
          </Gallery>
        </Section>
      )}
    </div>
  );
}

// A title in the library and a title that is not in it have one tree. When the user adds the title, the page changes in place and does not mount again.
function TitleView({ header, title, reload }: { header: TitleDetail | TitlePreview; title?: TitleDetail; reload: () => Promise<unknown> }) {
  const [message, setMessage] = useState('');
  const [plan, setPlan] = useState<{ request: PlanRequest; subject: string | null } | null>(null);
  const [adding, setAdding] = useState<{ season: number | null } | null>(null);
  // The title that the user added stays on the page while the job brings its facts. Its own control shows the wait.
  const [pendingAdd, setPendingAdd] = useState<{ kind: 'series'; season: number | null } | { kind: 'movie' } | null>(null);
  const queueNotice = useQueueNotice();

  async function run(action: () => Promise<number>) {
    setMessage('');
    try {
      queueNotice(await action());
    } catch (err) {
      setMessage(describeError(err));
    }
  }

  // The modal closes after the page shows the title in the library.
  async function added() {
    await reload();
    setAdding(null);
  }

  // A series asks which seasons to download first, so it adds with a modal. The notice waits for the alerts of the
  // app to come back when the modal closes.
  async function addedSeries(season: number | null) {
    queueNotice(1);
    setPendingAdd({ kind: 'series', season });
    await added();
  }

  // A series with one season has nothing to choose, so it adds at once.
  async function addOneSeason(season: number) {
    setMessage('');
    setPendingAdd({ kind: 'series', season });
    try {
      await api('/library', { method: 'POST', body: seriesBody(header, [season]) });
      await addedSeries(season);
    } catch (err) {
      setPendingAdd(null);
      setMessage(describeError(err));
    }
  }

  function startAdd(season: number | null) {
    if (oneSeason === null) setAdding({ season });
    else void addOneSeason(oneSeason);
  }

  // A movie adds without the modal, and its Add waits for the facts that the queue job brings.
  async function addedMovie() {
    setPendingAdd({ kind: 'movie' });
    await added();
  }

  // A season that is not selected is added from the page of the series. Its override makes it monitored, and its
  // search starts at once, like the search of a season in the queue.
  async function addSeason(titleKey: string, season: number) {
    await api(`/library/${titleKey}/seasons/${season}`, { method: 'PATCH', body: { override: 'monitored' } });
    return search({ titleKey, season });
  }

  const series = header.mediaType === 'tv';
  // The seasons of a series that is not in the library decide whether the Add needs the modal.
  const seasons = useQuery<SeriesEpisodes>({ queryKey: [`/search/tv/${header.tmdbId}/seasons`], enabled: series && !title });
  const seasonList = seasonOrder((seasons.data?.seasons ?? []).filter((season) => season.episodes.length > 0));
  // A series with one season has nothing to choose, so the Add adds it at once.
  const oneSeason = !title && seasonList.length === 1 ? seasonList[0]!.seasonNumber : null;
  // Search looks for what is missing, and Upgrade replaces a file that the library has. A series that lacks some episodes can need both.
  const hasFile = title ? (series ? (title.counts?.available ?? 0) > 0 : title.availability === 'available') : false;
  // The qualities that an upgrade can reach, so the button knows whether it has an option before the dialog opens.
  const upgrades = useQuery<{ qualities: UpgradeQuality[] }>({ queryKey: [`/library/${title?.key}/upgrades`], enabled: hasFile });
  useLive('library.changed', () => void upgrades.refetch());
  // A title that was searched has a target in the queue, so it has no Search of its own.
  const searched = title !== undefined && title.queueStatus !== null && title.queueStatus !== 'available';
  // The facts of a title that was just added arrive after the add. The page keeps its content, and the control that
  // started the add shows the wait.
  const addLoading = pendingAdd !== null && (title === undefined || (pendingAdd.kind === 'movie' ? title.metaLoadedAt === null : title.episodesLoadedAt === null));
  // The wait ends when the facts arrive. The state goes so a later removal does not show it again.
  useEffect(() => {
    if (!addLoading) setPendingAdd(null);
  }, [addLoading]);

  return (
    <>
      <TitleHeader
        header={header}
        mediaType={header.mediaType}
        tmdbId={header.tmdbId}
        resolutions={title?.resolutions}
        controls={
          pendingAdd && addLoading && (pendingAdd.kind === 'movie' || pendingAdd.season === null || oneSeason !== null) ? (
            <Button pending>{t('Add')}</Button>
          ) : title ? (
            <Actions>
              {title.availability !== 'available' && !searched && (
                <span title={series && title.availability === 'waiting' ? t('Not aired') : undefined}>
                  <Button disabled={series && title.availability === 'waiting'} onClick={() => void run(() => search({ titleKey: title.key }))}>
                    {t('Search')}
                  </Button>
                </span>
              )}
              {hasFile && <UpgradeDialog titleKey={title.key} qualities={upgrades.data?.qualities} error={upgrades.error} />}
              <Button variant="danger" onClick={() => setPlan({ request: { action: 'remove', keys: [title.key] }, subject: title.title })}>
                {t('Delete')}
              </Button>
            </Actions>
          ) : series ? (
            <Button onClick={() => startAdd(null)}>{t('Add')}</Button>
          ) : (
            <AddMovie result={header} onAdded={addedMovie} />
          )
        }
      />
      {message && <Alert tone="danger">{message}</Alert>}
      <PlanDialog request={plan?.request ?? null} subject={plan?.subject} onClose={() => setPlan(null)} onDone={() => void reload()} />
      {series && (
        <>
          <div className={`${pageWidth} grid gap-6`}>
            {title && !addLoading ? <Seasons title={title} onAddSeason={(season) => void run(() => addSeason(title.key, season))} onRemoveSeason={(season) => setPlan({ request: { action: 'remove', keys: [title.key], season }, subject: seasonName(season) })} /> : <PreviewSeasons tmdbId={header.tmdbId} onAddSeason={startAdd} pending={addLoading && pendingAdd?.kind === 'series' ? pendingAdd : null} />}
          </div>
        </>
      )}
      {!title && series && adding && <AddSeries result={header} season={adding.season} onClose={() => setAdding(null)} onAdded={() => addedSeries(adding.season)} />}
      <TitleExtras mediaType={header.mediaType} tmdbId={String(header.tmdbId)} />
    </>
  );
}

// The seasons of a series that is not in the library, with a checkbox for each one. The checkbox of the first column
// selects all of them.
function SeasonChoice({ tmdbId, chosen, onChange }: { tmdbId: number; chosen: Set<number>; onChange: (next: Set<number>) => void }) {
  const { data, error, refetch: reload } = useQuery<SeriesEpisodes>({ queryKey: [`/search/tv/${tmdbId}/seasons`] });
  if (error && !data) return <LoadFailed onRetry={reload} />;
  if (!data) return <Spinner label={t('Loading episodes')} />;
  const seasons = seasonOrder(data.seasons.filter((season) => season.episodes.length > 0));
  if (seasons.length === 0) return <EmptyState>{t('No episodes.')}</EmptyState>;
  const all = seasons.every((season) => chosen.has(season.seasonNumber));
  const chooseAll = (
    <Checkbox
      label={t('All seasons')}
      checked={all}
      onCheckedChange={(on) => onChange(on ? new Set(seasons.map((season) => season.seasonNumber)) : new Set())}
    />
  );
  const choose = (season: number, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(season);
    else next.delete(season);
    onChange(next);
  };
  return (
    <Table
      aria-label={t('Seasons')}
      columns={[{ label: chooseAll }, { label: t('# of episodes') }]}
      rows={seasons.map((season) => ({
        key: String(season.seasonNumber),
        cells: [
          <Checkbox
            label={seasonName(season.seasonNumber)}
            checked={chosen.has(season.seasonNumber)}
            onCheckedChange={(on) => choose(season.seasonNumber, on)}
          />,
          season.episodes.length,
        ],
      }))}
    />
  );
}

// The title of the add modal says the type of title that the user adds.
const addTitle = (result: Pick<TitlePreview, 'mediaType' | 'seriesType'>) =>
  result.mediaType === 'movie' ? t('Add new movie') : result.seriesType === 'anime' ? t('Add new anime') : t('Add new series');

// Add on a movie that is not in the library adds it with the defaults of Settings, and the search starts at once.
function AddMovie({ result, onAdded }: { result: Pick<TitlePreview, 'mediaType' | 'tmdbId' | 'title' | 'year' | 'posterPath'>; onAdded: () => Promise<unknown> }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const queueNotice = useQueueNotice();

  async function add() {
    setPending(true);
    setError('');
    try {
      const summary = { title: result.title, year: result.year, posterPath: result.posterPath };
      await api('/library', { method: 'POST', body: { mediaType: result.mediaType, tmdbId: result.tmdbId, add: 'all', summary } });
      queueNotice(1);
      await onAdded();
    } catch (err) {
      setError(describeError(err));
      setPending(false);
    }
  }

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button pending={pending} onClick={() => void add()}>
        {t('Add')}
      </Button>
    </>
  );
}

// The body of the add of a series: each season that the user chose is monitored, and the ones that air later follow the setting.
const seriesBody = (result: Pick<TitlePreview, 'mediaType' | 'tmdbId' | 'title' | 'year' | 'posterPath'>, seasons: number[]) => ({
  mediaType: result.mediaType,
  tmdbId: result.tmdbId,
  add: 'future',
  summary: { title: result.title, year: result.year, posterPath: result.posterPath },
  ...(seasons.length ? { seasonOverrides: Object.fromEntries(seasons.map((choice) => [choice, 'monitored'])) } : {}),
});

// Add on a series asks which seasons to download first; with no season, the ones that air later are monitored. The
// season that a season pane started stays chosen.
function AddSeries({ result, season, onClose, onAdded }: { result: Pick<TitlePreview, 'mediaType' | 'tmdbId' | 'seriesType' | 'title' | 'year' | 'posterPath'>; season: number | null; onClose: () => void; onAdded: () => Promise<unknown> }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(season === null ? [] : [season]));

  async function add() {
    setPending(true);
    setError('');
    try {
      await api('/library', { method: 'POST', body: seriesBody(result, [...chosen]) });
      await onAdded();
    } catch (err) {
      setError(describeError(err));
      setPending(false);
    }
  }

  function close() {
    // The add in flight must end first.
    if (!pending) onClose();
  }

  return (
    <Modal open onOpenChange={(next) => !next && close()} title={addTitle(result)}>
      <SeasonChoice tmdbId={result.tmdbId} chosen={chosen} onChange={setChosen} />
      {error && <Alert tone="danger">{error}</Alert>}
      <ModalActions>
        <Button variant="ghost" autoFocus onClick={close}>
          {t('Cancel')}
        </Button>
        <Button pending={pending} onClick={() => void add()}>
          {t('Add')}
        </Button>
      </ModalActions>
    </Modal>
  );
}

// One page for every title. A title that is not in the library shows the same header and the same extras, and a button that adds it.
function TitlePage() {
  const { mediaType = '', tmdbId = '' } = useParams();
  const library = useQuery<{ title: TitleDetail }>({ queryKey: [`/library/${mediaType}:${tmdbId}`] });
  const missing = library.error?.message === 'not_found';
  const preview = useQuery<{ title: TitlePreview }>({ queryKey: [`/search/${mediaType}/${tmdbId}`], enabled: missing });
  useLive('library.changed', () => void library.refetch());
  useLive('queue.changed', () => void library.refetch());

  // After a removal the read of the title fails, and the old data stays. The page then shows the title that is not in the catalog.
  const title = library.data && !missing ? library.data.title : undefined;
  // A title that entered the queue first has a summary. The preview holds the full facts, and the add keeps it cached.
  const header = (title && title.metaLoadedAt !== null ? title : undefined) ?? preview.data?.title ?? title;
  if (header) return <TitleView key={`${mediaType}:${tmdbId}`} header={header} title={title} reload={() => library.refetch()} />;
  const failed = missing ? preview.error : library.error;
  if (failed) {
    return (
      <Pane className={pageWidth}>
        {failed.message === 'not_found' ? <EmptyState>{t('No title matches.')}</EmptyState> : <LoadFailed onRetry={() => void (missing ? preview.refetch() : library.refetch())} />}
      </Pane>
    );
  }
  return <TitleHeaderLoading />;
}

// The movies and the series of an actor. Each one opens its page, in the catalog or not.
function PersonPage() {
  const { personId } = useParams();
  const { data, error, refetch } = useQuery<PersonCredits>({ queryKey: [`/search/person/${personId}`] });

  if (error && !data) {
    return (
      <Pane className={pageWidth}>
        {error.message === 'not_found' ? <EmptyState>{t('No person matches.')}</EmptyState> : <LoadFailed onRetry={() => void refetch()} />}
      </Pane>
    );
  }
  return (
    <>
      {data ? (
        <TitleHeader
          header={{ title: data.person.name, year: null, overview: data.person.alsoKnownAs.length > 0 ? t('Also known as: {names}', { names: data.person.alsoKnownAs.join(', ') }) : '', posterPath: data.person.profilePath, backdropPath: null, rating: null, runtime: null, imdbId: null, tvdbId: null, date: null }}
          posterSize="h632"
        >
          {data.person.popularity !== null && <Badge>{t('Popularity {value}', { value: data.person.popularity.toFixed(1) })}</Badge>}
        </TitleHeader>
      ) : (
        <TitleHeaderLoading />
      )}
      <div className={column}>
        {!data ? (
          <LoadingGallery />
        ) : data.credits.length === 0 ? (
          <EmptyState>{t('No movies or series.')}</EmptyState>
        ) : (
          <Gallery>
            {data.credits.map((result) => (
              <ResultItem key={`${result.mediaType}:${result.tmdbId}`} result={result} size="sm" />
            ))}
          </Gallery>
        )}
      </div>
    </>
  );
}

export function Library() {
  return (
    <Routes>
      <Route index element={<LibraryList />} />
      <Route path="folders" element={<UntitledFolders />} />
      <Route path="person/:personId" element={<PersonPage />} />
      <Route path=":mediaType/:tmdbId" element={<TitlePage />} />
    </Routes>
  );
}
