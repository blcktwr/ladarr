import type { ClientTestResult, ClientView } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { Plus } from 'lucide-react';
import { ActionMenu, Button, Checkbox, Confirm, Dropdown, EmptyState, Field, Form, Modal, Section, Table, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { t } from '../../i18n/index.ts';


const testText = (test: ClientTestResult) =>
  test.ok
    ? t('Connected to qBittorrent {version} (WebUI API {apiVersion}).', { version: test.version, apiVersion: test.apiVersion })
    : test.code === 'rejected'
      ? t('The client rejects the login.')
      : t('The client does not answer. Check the address.');

type Draft = { name: string; type: 'qbittorrent'; host: string; port: string; authType: 'apiKey' | 'password'; apiKey: string; username: string; password: string; enabled: boolean; maxDownloads: string };

const empty: Draft = { name: '', type: 'qbittorrent', host: '', port: '', authType: 'password', apiKey: '', username: '', password: '', enabled: true, maxDownloads: '0' };

const draftOf = (client?: ClientView): Draft => (client ? { ...empty, name: client.name, type: client.type, host: client.host, port: String(client.port), authType: client.auth, username: client.username ?? '', enabled: client.enabled, maxDownloads: String(client.maxDownloads) } : empty);

// A host that holds its own port does not show the port again.
const addressOf = ({ host, port }: ClientView) => (new RegExp(`:${port}(?:/|$)`).test(host) ? host : `${host}:${port}`);

// The server keeps the secret of a client that exists. A secret that the person leaves empty is not in the body, so it stays as it is.
// The Host field can hold a full address, as the Address field of an indexer does. The port in it counts when the Port field is empty.
const portOf = (draft: Draft) => {
  const value = draft.port.trim() || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*:(\d+)/i.exec(draft.host.trim())?.[1];
  return value ? Number(value) : NaN;
};

const bodyOf = (draft: Draft, editing: boolean) => {
  const secret = (key: string, value: string) => (editing && !value ? {} : { [key]: value });
  return {
    name: draft.name,
    type: draft.type,
    host: draft.host,
    port: portOf(draft),
    auth: draft.authType === 'apiKey' ? { type: 'apiKey', ...secret('apiKey', draft.apiKey) } : { type: 'password', username: draft.username, ...secret('password', draft.password) },
    enabled: draft.enabled,
    maxDownloads: draft.maxDownloads.trim() ? Number(draft.maxDownloads) : NaN,
  };
};

// The form of a client, in a modal. The client is saved only with Add or Save. Test connection saves nothing.
// A new client is added only after a test that worked. A field that changes drops the result, so the test must run again.
// The buttons of the modal stay out of the content that scrolls, so they never cover a field.
function ClientForm({ client, onDone, open, onOpenChange, trigger }: { client?: ClientView; onDone: () => void; open?: boolean; onOpenChange?: (open: boolean) => void; trigger?: ReactElement }) {
  const editing = Boolean(client);
  const formId = useId();
  const [draft, setDraft] = useState(draftOf(client));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ClientTestResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<'test' | 'save' | null>(null);
  const set = (changes: Partial<Draft>) => {
    setDraft({ ...draft, ...changes });
    setErrors({});
    setResult(null);
  };

  const messages: Record<string, string> = {
    name: t('Enter a name.'),
    host: t('Enter a host name or an address, with no user name or password in it.'),
    port: t('Enter a port from 1 to 65535.'),
    apiKey: t('Enter the API key.'),
    username: t('Enter the user name.'),
    maxDownloads: t('Enter a whole number from 0 to 100.'),
  };

  async function run(action: 'test' | 'save') {
    if (action === 'save' && !editing && !result?.ok) return;
    setPending(action);
    setFailed(false);
    setResult(null);
    const body = bodyOf(draft, editing);
    try {
      if (action === 'test') setResult(await api<ClientTestResult>(client ? `/clients/${client.id}/test` : '/clients/test', { method: 'POST', body }));
      else {
        await api(client ? `/clients/${client.id}` : '/clients', { method: client ? 'PUT' : 'POST', body });
        onDone();
      }
    } catch (err) {
      const field = err instanceof ApiError ? String(err.body.field) : '';
      if (messages[field]) setErrors({ [field]: messages[field]! });
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
      title={editing ? t('Edit a download client') : t('Add a download client')}
      width="lg"
      actions={
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
        <div className="grid items-start grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_12rem] gap-x-4 w-full">
          <Field width="full" label={t('Name')} aria-required="true" error={errors.name} value={draft.name} onValueChange={(name) => set({ name })} />
          <Dropdown label={t('Type')} value={draft.type} options={[{ value: 'qbittorrent', label: 'qBittorrent' }]} onValueChange={(type) => set({ type: type as Draft['type'] })} />
        </div>
        <div className="grid items-start grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_8rem_12rem] gap-x-4 w-full">
          <Field width="full" label={t('Host')} aria-required="true" error={errors.host} value={draft.host} onValueChange={(host) => set({ host })} />
          <Field width="full" label={t('Port')} aria-required="true" inputMode="numeric" error={errors.port} value={draft.port} onValueChange={(port) => set({ port })} />
          <Field
            width="full"
            label={t('Concurrent downloads')}
            description={t('0 means no limit.')}
            inputMode="numeric"
            error={errors.maxDownloads}
            value={draft.maxDownloads}
            onValueChange={(maxDownloads) => set({ maxDownloads })}
          />
        </div>
        <div className={`grid items-start grid-cols-[minmax(0,1fr)] ${draft.authType === 'apiKey' ? 'sm:grid-cols-[12rem_minmax(0,1fr)]' : 'sm:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)]'} gap-x-4 w-full`}>
          <Dropdown
            label={t('Authentication')}
            value={draft.authType}
            options={[
              { value: 'password', label: t('Login') },
              { value: 'apiKey', label: t('API key') },
            ]}
            onValueChange={(authType) => set({ authType: authType as Draft['authType'] })}
          />
          {draft.authType === 'apiKey' ? (
            <Field width="full" label={t('API key')} aria-required={!editing || client?.auth !== 'apiKey'} type="password" error={errors.apiKey} value={draft.apiKey} onValueChange={(apiKey) => set({ apiKey })} />
          ) : (
            <>
              <Field width="full" label={t('User name')} aria-required="true" error={errors.username} value={draft.username} onValueChange={(username) => set({ username })} />
              <Field width="full" label={t('Password')} type="password" value={draft.password} onValueChange={(password) => set({ password })} />
            </>
          )}
        </div>
        <Checkbox label={t('Enabled')} checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} />
      </Form>
    </Modal>
  );
}

export function DownloadClients() {
  const { data, error, refetch: reload } = useQuery<{ clients: ClientView[] }>({ queryKey: ['/clients'] });
  const [test, setTest] = useState<ClientTestResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ClientView | null>(null);
  const [removing, setRemoving] = useState<ClientView | null>(null);
  const [removePending, setRemovePending] = useState(false);

  const done = () => {
    setOpen(false);
    setEditing(null);
    void reload();
  };

  async function runTest(client: ClientView) {
    setTest(null);
    setTest(await api<ClientTestResult>(`/clients/${client.id}/test`, { method: 'POST', body: {} }).catch((): ClientTestResult => ({ ok: false, code: 'unreachable' })));
  }

  // The checkbox in the row turns the client on or off. The server keeps the secrets that the body leaves out.
  async function toggle(client: ClientView, enabled: boolean) {
    setFailed(false);
    const auth = client.auth === 'password' ? { type: 'password', username: client.username } : { type: 'apiKey' };
    try {
      await api(`/clients/${client.id}`, { method: 'PUT', body: { name: client.name, type: client.type, host: client.host, port: client.port, auth, enabled } });
      void reload();
    } catch {
      setFailed(true);
    }
  }

  async function remove(client: ClientView) {
    setRemovePending(true);
    setFailed(false);
    try {
      await api(`/clients/${client.id}`, { method: 'DELETE' });
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
      <Section title={t('Download clients')}>
        <LoadFailed onRetry={reload} />
      </Section>
    );

  const add = (
    <ClientForm
      open={open}
      onOpenChange={setOpen}
      onDone={done}
      trigger={
        <Button disabled={!data}>
          <Plus />
          {t('Add client')}
        </Button>
      }
    />
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 w-full">
      {test && <Alert tone={test.ok ? 'success' : 'danger'}>{testText(test)}</Alert>}
      {failed && <Alert tone="danger">{t('The request did not complete. Try again.')}</Alert>}
      {data?.clients.length === 0 ? (
        <Section title={t('Download clients')} action={add}>
          <EmptyState>{t('No download client is set.')}</EmptyState>
        </Section>
      ) : (
        <Table
          title={t('Download clients')}
          action={add}
          loading={!data}
          columns={[{ label: t('Name') }, { label: t('Host') }, { label: t('Actions'), align: 'end' }]}
          rows={data?.clients.map((client) => ({
            key: client.id,
            cells: [
              <Checkbox label={client.name} checked={client.enabled} onCheckedChange={(enabled) => void toggle(client, enabled)} />,
              addressOf(client),
              <ActionMenu
                label={t('Actions for {name}', { name: client.name })}
                items={[
                  { label: t('Edit'), onClick: () => setEditing(client) },
                  { label: t('Test'), onClick: () => void runTest(client) },
                  { label: t('Remove'), danger: true, onClick: () => setRemoving(client) },
                ]}
              />,
            ],
          }))}
        />
      )}
      {editing && <ClientForm client={editing} open onOpenChange={(next) => !next && setEditing(null)} onDone={done} />}
      <Confirm open={removing !== null} onOpenChange={(next) => !next && !removePending && setRemoving(null)} title={t('Remove {name}?', { name: removing?.name ?? '' })} confirm={t('Remove')} pending={removePending} onConfirm={() => removing && void remove(removing)} />
    </div>
  );
}
