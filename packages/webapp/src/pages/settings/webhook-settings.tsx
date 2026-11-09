import type { WebhookTestResult, WebhookView } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { ActionMenu, Button, Confirm, EmptyState, Field, Form, Modal, Section, Table } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { ModalActions } from '../../components/modal-actions.tsx';
import { LoadFailed } from '../../components/load-failed.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { t } from '../../i18n/index.ts';


const testText = (test: WebhookTestResult) =>
  test.ok ? t('The receiver accepted the test event.') : test.code === 'rejected' ? t('The receiver answered with status {status}.', { status: String(test.status) }) : t('The receiver does not answer. Check the address.');

// The form of the webhook, in a modal. The address is a secret, so the form never shows the saved one: a save replaces it.
// The webhook is saved only with Add or Save. Test connection saves nothing.
function WebhookForm({ editing, onDone }: { editing: boolean; onDone: () => void }) {
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
        await api('/webhook', { method: 'PUT', body: { url } });
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
      {result && <Alert tone={result.ok ? 'success' : 'danger'}>{testText(result)}</Alert>}
      <ModalActions>
        <Button type="button" variant="ghost" pending={pending === 'test'} disabled={pending === 'save'} onClick={() => void run('test')}>
          {t('Test connection')}
        </Button>
        <Button type="submit" pending={pending === 'save'} disabled={pending === 'test'}>
          {editing ? t('Save') : t('Add')}
        </Button>
      </ModalActions>
    </Form>
  );
}

export function Webhook() {
  const { data, error, refetch: reload } = useQuery<{ webhook: WebhookView | null }>({ queryKey: ['/webhook'] });
  const [test, setTest] = useState<WebhookTestResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const saved = data?.webhook;

  const done = () => {
    setOpen(false);
    setEditing(false);
    void reload();
  };

  async function runTest() {
    setTest(null);
    setTest(await api<WebhookTestResult>('/webhook/test', { method: 'POST', body: {} }).catch((): WebhookTestResult => ({ ok: false, code: 'unreachable', status: null })));
  }

  async function remove() {
    setRemovePending(true);
    setFailed(false);
    try {
      await api('/webhook', { method: 'DELETE' });
      setRemoving(false);
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

  // ladarr sends its events to one address, so the button waits until the user removes the webhook that is set.
  const add = (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={t('Add a webhook')}
      width="lg"
      trigger={
        <Button disabled={!data || Boolean(saved)}>
          <Plus />
          {t('Add webhook')}
        </Button>
      }
    >
      <WebhookForm editing={false} onDone={done} />
    </Modal>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 w-full">
      {test && <Alert tone={test.ok ? 'success' : 'danger'}>{testText(test)}</Alert>}
      {failed && <Alert tone="danger">{t('The request did not complete. Try again.')}</Alert>}
      {data && !saved ? (
        <Section title={t('Webhook')} action={add}>
          <EmptyState>{t('No webhook is set.')}</EmptyState>
        </Section>
      ) : (
        <Table
          title={t('Webhook')}
          action={add}
          loading={!data}
          columns={[{ label: t('Address') }, { label: t('Actions'), align: 'end' }]}
          rows={
            saved
              ? [
                  {
                    key: 'webhook',
                    cells: [
                      saved.host,
                      <ActionMenu
                        label={t('Actions for {name}', { name: saved.host })}
                        items={[
                          { label: t('Edit'), onClick: () => setEditing(true) },
                          { label: t('Test'), onClick: () => void runTest() },
                          { label: t('Remove'), danger: true, onClick: () => setRemoving(true) },
                        ]}
                      />,
                    ],
                  },
                ]
              : undefined
          }
        />
      )}
      {editing && (
        <Modal open onOpenChange={(next) => !next && setEditing(false)} title={t('Edit the webhook')} width="lg">
          <WebhookForm editing onDone={done} />
        </Modal>
      )}
      <Confirm open={removing} onOpenChange={(next) => !next && !removePending && setRemoving(false)} title={t('Remove {name}?', { name: saved?.host ?? '' })} confirm={t('Remove')} pending={removePending} onConfirm={() => void remove()} />
    </div>
  );
}
