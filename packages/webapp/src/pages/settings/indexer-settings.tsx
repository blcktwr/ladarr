import type { IndexerRow, IndexerTestResult, SettingsResponse } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import { ActionMenu, Button, Checkbox, Confirm, Dropdown, EmptyState, Field, Form, Hint, Modal, Section, Table, TagInput, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { getLanguage, t } from '../../i18n/index.ts';
import { useLive } from '../../lib/live.ts';

const testText = (test: IndexerTestResult) =>
  test.ok
    ? t('Connected to the indexer.')
    : test.code === 'rejected'
      ? t('The indexer rejects the API key.')
      : test.code === 'invalid_response'
        ? t('The address is not a Torznab indexer.')
        : t('The indexer does not answer. Check the address.');

type Draft = { name: string; type: 'torznab'; baseUrl: string; apiKey: string; delay: string; languages: string[]; enableRss: boolean; enableAutomaticSearch: boolean; enableInteractiveSearch: boolean };

const empty: Draft = { name: '', type: 'torznab', baseUrl: '', apiKey: '', delay: '6', languages: [], enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true };

const draftOf = (indexer?: IndexerRow): Draft =>
  indexer
    ? { ...empty, name: indexer.name, baseUrl: indexer.baseUrl, delay: String(indexer.delaySeconds), languages: indexer.preferredLanguages, enableRss: indexer.enableRss, enableAutomaticSearch: indexer.enableAutomaticSearch, enableInteractiveSearch: indexer.enableInteractiveSearch }
    : empty;

const delayOf = (value: string) => (value.trim() === '' ? NaN : Number(value));
const delayValid = (seconds: number) => Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600;

// The form of an indexer, in a modal. The indexer is saved only with Add or Save. Test connection saves nothing.
// The indexer manager owns the fields of a pushed indexer, so its form has only the fields that ladarr owns.
// The buttons of the modal stay out of the content that scrolls, so they never cover a field.
function IndexerForm({ indexer, onDone, open, onOpenChange, trigger }: { indexer?: IndexerRow; onDone: () => void; open?: boolean; onOpenChange?: (open: boolean) => void; trigger?: ReactElement }) {
  const editing = Boolean(indexer);
  const managed = Boolean(indexer && !indexer.manual);
  const formId = useId();
  const [draft, setDraft] = useState(draftOf(indexer));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<IndexerTestResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<'test' | 'save' | null>(null);
  // The list does not hold the key, so the form asks for the key of the indexer that it edits.
  const saved = useQuery<{ apiKey: string }>({ queryKey: [`/indexers/${indexer?.id}/key`], enabled: editing && !managed, gcTime: 0 });
  const settings = useQuery<SettingsResponse>({ queryKey: ['/settings'] });
  const language = settings.data?.settings.language;
  const languageNames = useMemo(() => new Intl.DisplayNames([language ?? getLanguage()], { type: 'language' }), [language]);
  // A value that Intl does not read as a language tag stays as it is. One bad value does not break the form.
  const languageLabel = (value: string) => {
    try {
      return languageNames.of(value) ?? value;
    } catch {
      return value;
    }
  };
  const languageOptions = (settings.data?.aliasLanguageOptions ?? []).map((value) => ({ value, label: languageLabel(value) }));
  useEffect(() => {
    if (saved.data) setDraft((current) => (current.apiKey ? current : { ...current, apiKey: saved.data.apiKey }));
  }, [saved.data]);
  const set = (changes: Partial<Draft>) => {
    setDraft({ ...draft, ...changes });
    setErrors({});
    setResult(null);
  };

  const messages: Record<string, string> = {
    name: t('Enter a name.'),
    baseUrl: t('Enter the address of the indexer, with no user name or password in it.'),
    apiKey: t('Enter the API key.'),
    delaySeconds: t('Enter a number from 0 to 3600.'),
    preferredLanguages: t('Enter lowercase language codes, such as en or ja.'),
  };

  async function run(action: 'test' | 'save') {
    // A new indexer is added only after a test that worked. A field that changes drops the result, so the test must run again.
    if (action === 'save' && !editing && !result?.ok) return;
    const seconds = delayOf(draft.delay);
    if (!delayValid(seconds)) return setErrors({ delaySeconds: messages.delaySeconds! });
    setPending(action);
    setFailed(false);
    setResult(null);
    // The server keeps the key of an indexer that exists. A key that the person leaves empty is not in the body, so it stays as it is.
    const body = { name: draft.name, type: draft.type, baseUrl: draft.baseUrl, ...(editing && !draft.apiKey ? {} : { apiKey: draft.apiKey }), delaySeconds: seconds, preferredLanguages: draft.languages, enableRss: draft.enableRss, enableAutomaticSearch: draft.enableAutomaticSearch, enableInteractiveSearch: draft.enableInteractiveSearch };
    try {
      if (action === 'test') setResult(await api<IndexerTestResult>(indexer ? `/indexers/${indexer.id}/test` : '/indexers/test', { method: 'POST', body }));
      else {
        await (managed ? api(`/indexers/${indexer!.id}`, { method: 'PATCH', body: { delaySeconds: seconds, preferredLanguages: draft.languages } }) : api(indexer ? `/indexers/${indexer.id}` : '/indexers', { method: indexer ? 'PUT' : 'POST', body }));
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

  return (
    <Modal
      trigger={trigger}
      open={open}
      onOpenChange={(next) => onOpenChange?.(next)}
      title={editing ? t('Edit an indexer') : t('Add an indexer')}
      width="lg"
      actions={
        <>
          {!managed && (
            <>
              {result && (
                <div className="mr-auto grid gap-1">
                  <span className={`${result.ok ? 'text-success' : 'text-error'} text-[15px]/none font-[550] tracking-[.01em]`}>{result.ok ? t('Connected') : t('Error connecting')}</span>
                  {!result.ok && <Text variant="small">{testText(result)}</Text>}
                </div>
              )}
              <Button type="button" variant="ghost" pending={pending === 'test'} disabled={pending === 'save'} onClick={() => void run('test')}>
                {t('Test connection')}
              </Button>
            </>
          )}
          <Button type="submit" form={formId} pending={pending === 'save'} disabled={pending === 'test' || (!editing && !result?.ok)}>
            {editing ? t('Save') : t('Add')}
          </Button>
        </>
      }
    >
      <Form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          void run('save');
        }}
      >
        {failed && <Alert tone="danger">{t('The request did not complete. Try again.')}</Alert>}
        {!managed && (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_12rem] gap-x-4 w-full">
              <Field width="full" label={t('Name')} aria-required="true" error={errors.name} value={draft.name} onValueChange={(name) => set({ name })} />
              <Dropdown label={t('Type')} value={draft.type} options={[{ value: 'torznab', label: t('Torznab') }]} onValueChange={(type) => set({ type: type as Draft['type'] })} />
            </div>
            <Field width="full" label={t('Address')} aria-required="true" error={errors.baseUrl} value={draft.baseUrl} onValueChange={(baseUrl) => set({ baseUrl })} />
          </>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_auto] gap-x-4 items-start w-full">
          {!managed && <Field width="full" label={t('API key')} aria-required={!editing} type="password" error={errors.apiKey} value={draft.apiKey} onValueChange={(apiKey) => set({ apiKey })} />}
          <Field width="sm" suffix={t('sec')} label={t('Delay requests')} aria-required="true" inputMode="decimal" action={<Hint label={t('About the delay')}>{t('The least time, in seconds, between two requests to the indexer.')}</Hint>} error={errors.delaySeconds} value={draft.delay} onValueChange={(delay) => set({ delay })} />
        </div>
        <TagInput
          label={t('Preferred languages')}
          value={draft.languages}
          onValueChange={(languages) => set({ languages })}
          options={languageOptions}
          width="full"
          description={t('A search sends an alias only to an indexer with one of these languages. No languages means every language.')}
          emptyText={t('No options. Type a value and press Enter.')}
          error={errors.preferredLanguages}
        />
        {!managed && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 justify-items-start w-full">
            <Checkbox label={t('RSS')} checked={draft.enableRss} onCheckedChange={(enableRss) => set({ enableRss })} />
            <Checkbox label={t('Automatic search')} checked={draft.enableAutomaticSearch} onCheckedChange={(enableAutomaticSearch) => set({ enableAutomaticSearch })} />
            <Checkbox label={t('Interactive search')} checked={draft.enableInteractiveSearch} onCheckedChange={(enableInteractiveSearch) => set({ enableInteractiveSearch })} />
          </div>
        )}
      </Form>
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
      await api(`/indexers/${indexer.id}`, { method: 'PUT', body: { name: indexer.name, type: 'torznab', baseUrl: indexer.baseUrl, delaySeconds: indexer.delaySeconds, preferredLanguages: indexer.preferredLanguages, enableRss: enabled, enableAutomaticSearch: enabled, enableInteractiveSearch: enabled } });
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
                  ...(row.manual ? [{ label: t('Remove'), danger: true, onClick: () => setRemoving(row) }] : []),
                ]}
              />,
            ],
          }))}
        />
      )}
      {editing && (
        <IndexerForm indexer={editing} open onOpenChange={(next) => !next && setEditing(null)} onDone={done} />
      )}
      <Confirm open={removing !== null} onOpenChange={(next) => !next && !removePending && setRemoving(null)} title={t('Remove {name}?', { name: removing?.name ?? '' })} confirm={t('Remove')} pending={removePending} onConfirm={() => removing && void remove(removing)} />
    </div>
  );
}
