import type { AlertView } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { alert, useModalOpen } from 'nebula';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { t } from '../i18n/index.ts';

// Tells the person that ladarr put the targets in the queue, and that it processes them soon.
// The alert opens the queue, so the person sees the work.
export function useQueueNotice() {
  const navigate = useNavigate();
  const modalOpen = useModalOpen();
  const alerts = useQuery<{ alerts: AlertView[] }>({ queryKey: ['/alerts'] });
  const waiting = useRef<number | null>(null);
  const show = (count: number) =>
    alert.success(t('Added to the queue'), count > 1 ? t('They are processed soon.') : t('It is processed soon.'), {
      action: { label: t('Open the queue'), onClick: () => void navigate('/activity') },
    });

  // A modal holds the alerts of the app back, and they come back when it closes. The notice of an add that starts
  // in a modal waits for the alerts, so a problem of the app does not hide it.
  useEffect(() => {
    if (modalOpen || alerts.isPending || waiting.current === null) return;
    const count = waiting.current;
    waiting.current = null;
    show(count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, alerts.isPending]);

  return (count: number) => {
    if (modalOpen) waiting.current = count;
    else show(count);
  };
}
