import type { WebhookTestResult, WebhookView } from '@ladarr/shared/types';
import type { WebhookEventType } from '@ladarr/shared/enums';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { ActionMenu, Button, Confirm, Dropdown, EmptyState, Field, Form, Modal, Section, Table } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { ModalActions } from '../../components/modal-actions.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { t } from '../../i18n/index.ts';

const EVENT_LABELS: Record<WebhookEventType, string> = {
  stuck: 'Stuck',
  available: 'Completed',
};

const testText = (test: WebhookTestResult) =>
  test.ok ? t('The receiver accepted the test event.') : test.code === 'rejected' ? t('The receiver answered with status {status}.', { status: String(test.status) }) : t('The receiver does not answer. Check the address.');

// The form of a webhook, in a modal. Each webhook has one event type and one address.
// The address is a secret, so the form never shows the saved one: a save replaces it.
// The webhook is saved only with Add or Save. Test connection saves nothing.
function WebhookForm({ webhook, onDone }: { webhook?: WebhookView; onDone: () => void }) {
  const [type, setType] = useState<WebhookEventType>(webhook?.type ?? 'available');
  const [url, setUrl] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [failed, setFailed] = useState(false);
  const [result, setResult] = useState<WebhookTestResult | null>(null);
  const [pending, setPending] = useState<'test' | 'save' | null>(null);

  async function run(action: 'test' | 'save') {
    setPending(action);
    setFailed(false);
    setResult(null);
    try {
      if (action === 'test') setResult(await api<WebhookTestResult>('/webhook/test', { method: 'POST', body: { url } }));
      else {
        await api(webhook ? `/webhook/${webhook.id}` : '/webhook', { method: webhook ? 'PUT' : 'POST', body: { type, url } });
        onDone();
      }
    } catch (err) {
      if (err instanceof ApiError && err.body.field === 'url') setInvalid(true);
      else setFailed(true);
    } finally {
      setPending(null);
    }
  }

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        void run('save');
      }}
    >
      {failed && <Alert tone="danger">{t('The request did not complete. Try again.')}</Alert>}
      <div className="grid items-start grid-cols-[minmax(0,1fr)] sm:grid-cols-[12rem_minmax(0,1fr)] gap-x-4 w-full">
        <Dropdown
          label={t('Event')}
          value={type}
          options={(Object.entries(EVENT_LABELS) as [WebhookEventType, string][]).map(([value, label]) => ({ value, label: t(label) }))}
          onValueChange={(value) => value && setType(value as WebhookEventType)}
        />
        <Field
          width="full"
          label={t('Address')}
          aria-required="true"
          error={invalid ? t('Enter an http or https address with no user name or password in it.') : undefined}
          value={url}
          onValueChange={(value) => {
            setUrl(value);
            setInvalid(false);
            setResult(null);
          }}
        />
      </div>
      {result && <Alert tone={result.ok ? 'success' : 'danger'}>{testText(result)}</Alert>}
      <ModalActions>
        <Button type="button" variant="ghost" pending={pending === 'test'} disabled={pending === 'save'} onClick={() => void run('test')}>
          {t('Test connection')}
        </Button>
        <Button type="submit" pending={pending === 'save'} disabled={pending === 'test'}>
          {webhook ? t('Save') : t('Add')}
        </Button>
      </ModalActions>
    </Form>
  );
}

export function Webhook() {
  const { data, error, refetch: reload } = useQuery<{ webhooks: WebhookView[] }>({ queryKey: ['/webhook'] });
  const [test, setTest] = useState<WebhookTestResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookView | null>(null);
  const [removing, setRemoving] = useState<WebhookView | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const saved = data?.webhooks ?? [];

  const name = (webhook: WebhookView) => `${t(EVENT_LABELS[webhook.type])} ${webhook.host}`;

  const done = () => {
    setOpen(false);
    setEditing(null);
    void reload();
  };

  async function runTest(webhook: WebhookView) {
    setTest(null);
    setTest(await api<WebhookTestResult>(`/webhook/${webhook.id}/test`, { method: 'POST', body: {} }).catch((): WebhookTestResult => ({ ok: false, code: 'unreachable', status: null })));
  }

  async function remove() {
    if (!removing) return;
    setRemovePending(true);
    setFailed(false);
    try {
      await api(`/webhook/${removing.id}`, { method: 'DELETE' });
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
      <Section title={t('Webhook')}>
        <LoadFailed onRetry={reload} />
      </Section>
    );

  const add = (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={t('Add a webhook')}
      width="lg"
      trigger={
        <Button disabled={!data}>
          <Plus />
          {t('Add webhook')}
        </Button>
      }
    >
      <WebhookForm onDone={done} />
    </Modal>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 w-full">
      {test && <Alert tone={test.ok ? 'success' : 'danger'}>{testText(test)}</Alert>}
      {failed && <Alert tone="danger">{t('The request did not complete. Try again.')}</Alert>}
      {data && !saved.length ? (
        <Section title={t('Webhook')} action={add}>
          <EmptyState>{t('No webhook is set.')}</EmptyState>
        </Section>
      ) : (
        <Table
          title={t('Webhook')}
          action={add}
          loading={!data}
          columns={[{ label: t('Event') }, { label: t('Address') }, { label: t('Actions'), align: 'end' }]}
          rows={
            data
              ? saved.map((webhook) => ({
                  key: webhook.id,
                  cells: [
                    t(EVENT_LABELS[webhook.type]),
                    webhook.host,
                    <ActionMenu
                      label={t('Actions for {name}', { name: name(webhook) })}
                      items={[
                        { label: t('Edit'), onClick: () => setEditing(webhook) },
                        { label: t('Test'), onClick: () => void runTest(webhook) },
                        { label: t('Remove'), danger: true, onClick: () => setRemoving(webhook) },
                      ]}
                    />,
                  ],
                }))
              : undefined
          }
        />
      )}
      {editing && (
        <Modal open onOpenChange={(next) => !next && setEditing(null)} title={t('Edit the webhook')} width="lg">
          <WebhookForm key={editing.id} webhook={editing} onDone={done} />
        </Modal>
      )}
      <Confirm
        open={Boolean(removing)}
        onOpenChange={(next) => !next && !removePending && setRemoving(null)}
        title={t('Remove {name}?', { name: removing ? name(removing) : '' })}
        confirm={t('Remove')}
        pending={removePending}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
