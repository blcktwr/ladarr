import type { AlertView } from '@ladarr/shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { alert } from 'nebula';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { t } from '../i18n/index.ts';
import { useLive } from '../lib/live.ts';

// The problems of the setup show as alerts. The server collects them, so every page shows the same list. A new indexer
// or client can fix a problem, so the setup changes load the list again.
export function AlertsFeed() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useQuery<{ alerts: AlertView[] }>({ queryKey: ['/alerts'] });
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['/alerts'] });
  useLive('indexers.changed', reload);
  useLive('clients.changed', reload);
  // The alerts that opened in this visit, keyed by the ID of the alert. A closed alert stays here, so it does not open
  // again while the page stays open and the server still sends it. A new visit opens every alert again, so the person
  // always sees a problem that is still there.
  const opened = useRef(new Map<string, string>());

  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.alerts.map((item) => item.id));
    opened.current.forEach((toastId, id) => {
      if (ids.has(id)) return;
      alert.close(toastId);
      opened.current.delete(id);
    });
    // The server sends the oldest alert first. The queue puts the newest in front, so they go in the other order.
    for (const item of [...data.alerts].reverse()) {
      if (opened.current.has(item.id)) continue;
      const settings = item.id === 'problem:client_missing' ? '/settings#connections' : '/settings';
      const action = { label: t('Open settings'), onClick: () => void navigate(settings) };
      const toastId = alert.warn(t(item.title, item.params), t(item.message, item.params), { timeout: 0, action });
      opened.current.set(item.id, toastId);
    }
  }, [data, navigate]);

  return null;
}
