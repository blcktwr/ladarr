import type { IndexerRow, IndexerTestResult } from '@ladarr/shared/types';
import { DEFAULT_RELEASE_DAY_MINUTES, validReleaseDayMinutes } from '@ladarr/shared/indexers';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { ActionMenu, Button, Checkbox, Confirm, Dropdown, EmptyState, Field, Form, Hint, Modal, MultiSelect, Section, Table, TagInput, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { t, useLanguage } from '../../i18n/index.ts';
import { useLive } from '../../lib/live.ts';
import { languages } from '../../lib/languages.ts';

const testText = (test: IndexerTestResult) =>
  test.ok
    ? t('Connected to the indexer.')
    : test.code === 'rejected'
      ? t('The indexer rejects the API key.')
      : test.code === 'invalid_response'
        ? t('The address is not a Torznab indexer.')
        : t('The indexer does not answer. Check the address.');

// The standard Torznab categories for series and movies. The indexer ignores a category that it does not have.
const CATEGORY_OPTIONS = [
  { value: '2000', label: '2000 Movies' },
  { value: '2010', label: '2010 Movies/Foreign' },
  { value: '2020', label: '2020 Movies/Other' },
  { value: '2030', label: '2030 Movies/SD' },
  { value: '2040', label: '2040 Movies/HD' },
  { value: '2045', label: '2045 Movies/UHD' },
  { value: '2050', label: '2050 Movies/BluRay' },
  { value: '2060', label: '2060 Movies/3D' },
  { value: '2070', label: '2070 Movies/DVD' },
  { value: '2080', label: '2080 Movies/WEB-DL' },
  { value: '2090', label: '2090 Movies/x264' },
  { value: '2100', label: '2100 Movies/x265' },
  { value: '5000', label: '5000 TV' },
  { value: '5010', label: '5010 TV/Foreign' },
  { value: '5020', label: '5020 TV/Other' },
  { value: '5030', label: '5030 TV/SD' },
  { value: '5040', label: '5040 TV/HD' },
  { value: '5045', label: '5045 TV/UHD' },
  { value: '5050', label: '5050 TV/BluRay' },
  { value: '5060', label: '5060 TV/3D' },
  { value: '5070', label: '5070 TV/Anime' },
  { value: '5080', label: '5080 TV/DVD' },
  { value: '5090', label: '5090 TV/WEB-DL' },
  { value: '5100', label: '5100 TV/x264' },
  { value: '5110', label: '5110 TV/x265' },
];

type Draft = { name: string; type: 'torznab'; baseUrl: string; apiKey: string; delay: string; releaseDayMinutes: string; languages: string[]; categories: string[]; enableRss: boolean; enableAutomaticSearch: boolean; enableInteractiveSearch: boolean; rejectZeroSeeders: boolean };

const empty: Draft = { name: '', type: 'torznab', baseUrl: '', apiKey: '', delay: '6', releaseDayMinutes: String(DEFAULT_RELEASE_DAY_MINUTES), languages: [], categories: [], enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, rejectZeroSeeders: false };

const draftOf = (indexer?: IndexerRow): Draft =>
  indexer
    ? { ...empty, name: indexer.name, baseUrl: indexer.baseUrl, delay: String(indexer.delaySeconds), releaseDayMinutes: String(indexer.releaseDayMinutes), languages: indexer.preferredLanguages, categories: indexer.categories.map(String), enableRss: indexer.enableRss, enableAutomaticSearch: indexer.enableAutomaticSearch, enableInteractiveSearch: indexer.enableInteractiveSearch, rejectZeroSeeders: indexer.rejectZeroSeeders }
    : empty;

const delayOf = (value: string) => (value.trim() === '' ? NaN : Number(value));
const delayValid = (seconds: number) => Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600;

// The form of an indexer, in a modal. The indexer is saved only with Add or Save. Test connection saves nothing.
// The connection fields of a pushed indexer are read-only.
// The buttons of the modal stay out of the content that scrolls, so they never cover a field.
function IndexerForm({ indexer, onDone, open, onOpenChange, trigger }: { indexer?: IndexerRow; onDone: () => void; open?: boolean; onOpenChange?: (open: boolean) => void; trigger?: ReactElement }) {
  const editing = Boolean(indexer);
  const managed = Boolean(indexer && !indexer.manual);
  const formId = useId();
  const [draft, setDraft] = useState(draftOf(indexer));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<IndexerTestResult | null>(null);
  const [categoriesUpdated, setCategoriesUpdated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<'test' | 'save' | null>(null);
  const [delayFocused, setDelayFocused] = useState(false);
  // The list does not hold the key, so the form asks for the key of the indexer that it edits.
  const saved = useQuery<{ apiKey: string }>({ queryKey: [`/indexers/${indexer?.id}/key`], enabled: editing && !managed, gcTime: 0 });
  const language = useLanguage();
  const languageOptions = useMemo(
    () =>
      languages
        .map(({ value, name }) => ({ value, label: t(name) }))
        .sort((a, b) => a.label.localeCompare(b.label, language)),
    [language],
  );
  useEffect(() => {
    if (saved.data) setDraft((current) => (current.apiKey ? current : { ...current, apiKey: saved.data.apiKey }));
  }, [saved.data]);
  const set = (changes: Partial<Draft>) => {
    setDraft({ ...draft, ...changes });
    setErrors({});
    // The address and the key are what the test asks. A change to any other field keeps a test that worked.
    if (changes.baseUrl !== undefined || changes.apiKey !== undefined) setResult(null);
    setCategoriesUpdated(false);
  };

  // A test is needed only when the address or the key changes, or when the indexer is new.
  const connectionChanged = !editing || draft.baseUrl !== indexer!.baseUrl || (draft.apiKey !== '' && draft.apiKey !== saved.data?.apiKey);
  const needsTest = !managed && connectionChanged;

  const messages: Record<string, string> = {
    name: t('Enter a name.'),
    baseUrl: t('Enter the address of the indexer, with no user name or password in it.'),
    apiKey: t('Enter the API key.'),
    delaySeconds: t('Enter a number from 0 to 3600.'),
    releaseDayMinutes: t('Enter a whole number from 1 to 1440.'),
    preferredLanguages: t('Enter lowercase language codes, such as en or ja.'),
    categories: t('Enter categories as numbers.'),
  };

  async function run(action: 'test' | 'save') {
    // The indexer is saved only after a test that worked, when the address or the key changed.
    if (action === 'save' && needsTest && !result?.ok) return;
    const seconds = delayOf(draft.delay);
    const minutes = Number(draft.releaseDayMinutes);
    if (action === 'save' && !delayValid(seconds)) return setErrors({ delaySeconds: messages.delaySeconds! });
    if (action === 'save' && !validReleaseDayMinutes(minutes)) return setErrors({ releaseDayMinutes: messages.releaseDayMinutes! });
    setPending(action);
    setFailed(false);
    setResult(null);
    // The server keeps the key of an indexer that exists. A key that the person leaves empty is not in the body, so it stays as it is.
    const connection = { name: draft.name, type: draft.type, baseUrl: draft.baseUrl, ...(editing && !draft.apiKey ? {} : { apiKey: draft.apiKey }) };
    const parameters = { delaySeconds: seconds, releaseDayMinutes: minutes, preferredLanguages: draft.languages, rejectZeroSeeders: draft.rejectZeroSeeders };
    try {
      if (action === 'test') {
        const test = await api<IndexerTestResult>(indexer ? `/indexers/${indexer.id}/test` : '/indexers/test', { method: 'POST', body: connection });
        // The indexer lists the categories that it has. A selected category that is not in the list goes, so a search does not ask for a category that does not exist.
        if (test.ok) {
          const listed = new Set(test.categories.map(String));
          const kept = draft.categories.filter((value) => listed.has(value));
          const changed = kept.length !== draft.categories.length;
          setCategoriesUpdated(changed);
          if (changed) setDraft({ ...draft, categories: kept });
        }
        setResult(test);
      } else {
        const body = managed ? parameters : { ...connection, ...parameters, categories: draft.categories.map(Number), enableRss: draft.enableRss, enableAutomaticSearch: draft.enableAutomaticSearch, enableInteractiveSearch: draft.enableInteractiveSearch };
        await api(indexer ? `/indexers/${indexer.id}` : '/indexers', { method: managed ? 'PATCH' : editing ? 'PUT' : 'POST', body });
        onDone();
      }
    } catch (err) {
      const field = err instanceof ApiError ? String(err.body.field) : '';
      if (err instanceof ApiError && err.body.error === 'exists') setErrors({ baseUrl: t('This indexer is already in the list.') });
      else if (messages[field]) setErrors({ [field]: messages[field]! });
      else setFailed(true);
    } finally {
      setPending(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run('save');
  }

  const categories = (
    <MultiSelect
      label={t('Categories')}
      value={draft.categories}
      onValueChange={(categories) => set({ categories })}
      options={CATEGORY_OPTIONS}
      valueText={(count) => t('{n} selected', { n: count })}
      width="full"
      error={errors.categories}
    />
  );
  const delay = (
    <div className="w-52 max-w-full">
      <Field width="full" suffix={t('sec')} label={t('Delay between requests')} aria-required="true" inputMode="decimal" action={<Hint label={t('About the delay')}>{t('The least time, in seconds, between two requests to the indexer.')}</Hint>} error={errors.delaySeconds} value={!delayFocused && draft.delay.trim() === '0' ? '∞' : draft.delay} onFocus={() => setDelayFocused(true)} onBlur={() => setDelayFocused(false)} onValueChange={(delay) => set({ delay })} />
    </div>
  );
  const connection = (
    <>
      <div className={editing ? 'grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_12rem] gap-x-4 w-full' : 'grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_12rem_minmax(0,1fr)] gap-x-4 w-full'}>
        <Field width="full" label={t('Name')} readOnly={managed} aria-required={!managed} error={errors.name} value={draft.name} onValueChange={(name) => set({ name })} />
        {managed
          ? <Field width="full" label={t('Type')} readOnly value={indexer?.type === 'newznab' ? t('Newznab') : t('Torznab')} />
          : <Dropdown label={t('Type')} value={draft.type} options={[{ value: 'torznab', label: t('Torznab') }]} onValueChange={(type) => set({ type: type as Draft['type'] })} />}
        {!editing && categories}
      </div>
      <Field width="full" label={t('Address')} readOnly={managed} aria-required={!managed} error={errors.baseUrl} value={draft.baseUrl} onValueChange={(baseUrl) => set({ baseUrl })} />
      {!managed && (
        <div className={editing ? 'w-full' : 'grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_auto] gap-x-4 items-start w-full'}>
          <Field width="full" label={t('API key')} aria-required={!editing} type="password" error={errors.apiKey} value={draft.apiKey} onValueChange={(apiKey) => set({ apiKey })} />
          {!editing && delay}
        </div>
      )}
    </>
  );
  const parameters = (
    <>
      <div className={`flex flex-wrap items-start gap-4 w-full${editing && !managed ? ' justify-between' : ''}`}>
        {editing && !managed && <div className="w-52 max-w-full">{categories}</div>}
        {editing && delay}
        <div className="w-52 max-w-full">
          <Field
            width="full"
            label={t('Release day, search interval')}
            suffix="min"
            aria-required="true"
            inputMode="numeric"
            action={<Hint label={t('About the release-day search interval')}>{t('Minutes between automatic searches on this indexer for the same movie or episode on its release day.')}</Hint>}
            value={draft.releaseDayMinutes}
            onValueChange={(releaseDayMinutes) => set({ releaseDayMinutes })}
            error={errors.releaseDayMinutes}
          />
        </div>
      </div>
      <TagInput
        label={t('Preferred languages')}
        value={draft.languages}
        onValueChange={(languages) => set({ languages })}
        options={languageOptions}
        allowCustom={false}
        width="full"
        description={t('A search sends an alias only to an indexer with one of these languages. No languages means every language.')}
        emptyText={t('No options.')}
        error={errors.preferredLanguages}
      />
      <div className="grid sm:grid-cols-2 items-start gap-4 w-full">
        {([
          ['enableRss', t('RSS'), t('Read the indexer feed for new releases.')],
          ['enableAutomaticSearch', t('Automatic search'), t('Find wanted movies and episodes.')],
          ['enableInteractiveSearch', t('Manual search'), t('Include this indexer in searches you start.')],
          ['rejectZeroSeeders', t('Reject releases with no seeders'), t('Skip downloads with zero seeders.')],
        ] as const).map(([field, label, description]) => {
          if (managed && field !== 'rejectZeroSeeders') return null;
          const descriptionId = `${formId}-${field}`;
          return (
            <div key={field} className="grid justify-items-start gap-1">
              <Checkbox label={label} aria-describedby={descriptionId} checked={draft[field]} onCheckedChange={(checked) => set({ [field]: checked })} />
              <div id={descriptionId} className="ml-11"><Text variant="small">{description}</Text></div>
            </div>
          );
        })}
      </div>
    </>
  );
  const failure = failed && <Alert tone="danger">{t('The request did not complete. Try again.')}</Alert>;
  const connectionError = errors.name ?? errors.baseUrl ?? errors.apiKey;
  const parameterError = errors.releaseDayMinutes ?? errors.delaySeconds ?? errors.categories ?? errors.preferredLanguages;

  return (
    <Modal
      trigger={trigger}
      open={open}
      onOpenChange={(next) => onOpenChange?.(next)}
      title={editing ? t('Edit an indexer') : t('Add an indexer')}
      hideTitle={editing}
      width="lg"
      tabs={editing ? [
        { value: 'connection', label: t('Indexer'), content: <Form id={formId} onSubmit={submit}>{connection}</Form> },
        { value: 'parameters', label: t('Parameters'), content: <Form onSubmit={submit}>{parameters}</Form> },
      ] : undefined}
      actions={
        <>
          {failure}
          {editing && parameterError && <Alert tone="danger" title={t('Parameters')}>{parameterError}</Alert>}
          {editing && connectionError && <Alert tone="danger" title={t('Connection')}>{connectionError}</Alert>}
          {!managed && (
            <>
              {result && (
                <div className="mr-auto grid gap-1">
                  <span className={`${result.ok ? 'text-success' : 'text-error'} text-[15px]/none font-[550] tracking-[.01em]`}>{result.ok ? t(categoriesUpdated ? 'Connected, categories updated' : 'Connected') : t('Error connecting')}</span>
                  {!result.ok && <Text variant="small">{testText(result)}</Text>}
                </div>
              )}
              <Button type="button" variant="ghost" pending={pending === 'test'} disabled={pending === 'save'} onClick={() => void run('test')}>
                {t('Test connection')}
              </Button>
            </>
          )}
          <Button type="submit" form={formId} pending={pending === 'save'} disabled={pending === 'test' || (needsTest && !result?.ok)}>
            {editing ? t('Save') : t('Add')}
          </Button>
        </>
      }
    >
      {!editing && <Form id={formId} onSubmit={submit}>{connection}{parameters}</Form>}
    </Modal>
  );
}

export function Indexers() {
  const { data, error, refetch: reload } = useQuery<{ indexers: IndexerRow[] }>({ queryKey: ['/indexers'] });
  useLive('indexers.changed', () => void reload());
  const [test, setTest] = useState<IndexerTestResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<IndexerRow | null>(null);
  const [removing, setRemoving] = useState<IndexerRow | null>(null);
  const [removePending, setRemovePending] = useState(false);

  const done = () => {
    setOpen(false);
    setEditing(null);
    void reload();
  };

  async function runTest(indexer: IndexerRow) {
    setTest(null);
    setTest(await api<IndexerTestResult>(`/indexers/${indexer.id}/test`, { method: 'POST', body: {} }).catch((): IndexerTestResult => ({ ok: false, code: 'unavailable' })));
    void reload();
  }

  // The checkbox turns the three uses of the indexer on or off together. The server keeps the key that the body leaves out.
  async function toggle(indexer: IndexerRow, enabled: boolean) {
    setFailed(false);
    try {
      await api(`/indexers/${indexer.id}`, { method: 'PUT', body: { name: indexer.name, type: 'torznab', baseUrl: indexer.baseUrl, delaySeconds: indexer.delaySeconds, preferredLanguages: indexer.preferredLanguages, categories: indexer.categories, enableRss: enabled, enableAutomaticSearch: enabled, enableInteractiveSearch: enabled } });
      void reload();
    } catch {
      setFailed(true);
    }
  }

  async function remove(indexer: IndexerRow) {
    setRemovePending(true);
    setFailed(false);
    try {
      await api(`/indexers/${indexer.id}`, { method: 'DELETE' });
      setRemoving(null);
      void reload();
    } catch {
      setFailed(true);
    } finally {
      setRemovePending(false);
    }
  }

  if (error && !data)
    return (
      <Section title={t('Indexers')}>
        <LoadFailed onRetry={reload} />
      </Section>
    );

  const add = (
    <IndexerForm
      open={open}
      onOpenChange={setOpen}
      onDone={done}
      trigger={
        <Button disabled={!data}>
          <Plus />
          {t('Add indexer')}
        </Button>
      }
    />
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 w-full">
      {test && <Alert tone={test.ok ? 'success' : 'danger'}>{testText(test)}</Alert>}
      {failed && <Alert tone="danger">{t('The request did not complete. Try again.')}</Alert>}
      {data?.indexers.length === 0 ? (
        <Section title={t('Indexers')} action={add}>
          <EmptyState>{t('No indexer is set.')}</EmptyState>
        </Section>
      ) : (
        <Table
          title={t('Indexers')}
          action={add}
          loading={!data}
          columns={[{ label: t('Name') }, { label: t('Type') }, { label: t('Actions'), align: 'end' }]}
          rows={data?.indexers.map((row) => ({
            key: String(row.id),
            cells: [
              // The indexer manager owns the flags of a pushed indexer, so its checkbox only shows the state.
              <Checkbox label={row.name} checked={row.enableRss || row.enableAutomaticSearch || row.enableInteractiveSearch} disabled={!row.manual} onCheckedChange={(enabled) => void toggle(row, enabled)} />,
              row.type === 'newznab' ? t('Newznab') : t('Torznab'),
              <ActionMenu
                label={t('Actions for {name}', { name: row.name })}
                items={[
                  { label: t('Edit'), onClick: () => setEditing(row) },
                  { label: t('Test'), onClick: () => void runTest(row) },
                  ...(row.manual ? [{ label: t('Delete'), danger: true, onClick: () => setRemoving(row) }] : []),
                ]}
              />,
            ],
          }))}
        />
      )}
      {editing && (
        <IndexerForm indexer={editing} open onOpenChange={(next) => !next && setEditing(null)} onDone={done} />
      )}
      <Confirm open={removing !== null} onOpenChange={(next) => !next && !removePending && setRemoving(null)} title={t('Delete {name}?', { name: removing?.name ?? '' })} confirm={t('Delete')} pending={removePending} onConfirm={() => removing && void remove(removing)} />
    </div>
  );
}
