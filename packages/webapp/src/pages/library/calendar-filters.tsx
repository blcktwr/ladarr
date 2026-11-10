import type { LibrarySearchRequest, SearchPlan } from '@ladarr/shared/types';
import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { t } from '../../i18n/index.ts';
import { Button, List, Modal, Row } from 'nebula';
import { describeError, errorMessages } from '../../lib/format.ts';
import { useQueueNotice } from '../../lib/queue-notice.ts';
import { ModalActions } from '../../components/modal-actions.tsx';

export const titleCount = (n: number) => (n === 1 ? t('1 title') : t('{n} titles', { n }));
export const fileCount = (n: number) => (n === 1 ? t('1 file') : t('{n} files', { n }));

// What a plan searches for: the missing files.
// The titles are a list of keys, or the titles of a library filter.
// Previews what a search starts. The search runs in the worker, in batches.
export function SearchPlanButton({ label, heading, request }: { label: string; heading: string; request: LibrarySearchRequest }) {
  const [plan, setPlan] = useState<SearchPlan | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const queueNotice = useQueueNotice();

  async function preview() {
    setMessage('');
    setBusy(true);
    try {
      const next = await api<SearchPlan>('/library/search/preview', { method: 'POST', body: request });
      if (next.planId) setPlan(next);
      else setMessage(errorMessages.nothing_to_search!);
    } catch (err) {
      setMessage(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const current = plan;
    setPlan(null);
    try {
      await api('/library/search', { method: 'POST', body: { planId: current?.planId } });
      queueNotice(current?.targets ?? 1);
    } catch (err) {
      setMessage(describeError(err));
    }
  }

  const titles = plan ? titleCount(plan.titles) : '';
  const close = () => {
    setPlan(null);
    setMessage('');
  };
  // The modal shows the plan, or the reason that there is no plan.
  return (
    <Modal
      open={Boolean(plan || message)}
      onOpenChange={(open) => !open && close()}
      title={heading}
      trigger={
        <Button variant="ghost" pending={busy} onClick={() => void preview()}>
          {label}
        </Button>
      }
    >
      {message ? (
        <p>{message}</p>
      ) : (
        plan && (
          <>
            <p>
              {t('Searching for {items} in {titles}.', {
                items: plan.targets === 1 ? t('1 episode or movie') : t('{n} episodes and movies', { n: plan.targets }),
                titles,
              })}
            </p>
            <List>
              {plan.sample.map((item) => (
                <Row key={item.key}>
                  {item.title}
                  {item.year ? ` (${item.year})` : ''}: {item.targets}
                </Row>
              ))}
            </List>
            {plan.titles > plan.sample.length && <p>{t('And {n} more.', { n: plan.titles - plan.sample.length })}</p>}
          </>
        )
      )}
      <ModalActions>
        {message ? (
          <Button autoFocus onClick={close}>
            {t('Close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" autoFocus onClick={close}>
              {t('Cancel')}
            </Button>
            <Button onClick={() => void start()}>{t('Search')}</Button>
          </>
        )}
      </ModalActions>
    </Modal>
  );
}
