import type { ReleaseRow } from '@ladarr/shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api.ts';
import { Button, EmptyState, List, Row, Section, Spinner } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { formatBytes } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { useQueueNotice } from '../../lib/queue-notice.ts';

type Target = { titleKey: string; season?: number; number?: number };

// The releases that the indexers have for one target, with the reason for each rejection.
export function ReleasesDialog({ target, label, onClose }: { target: Target | null; label: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const queueNotice = useQueueNotice();
  const params = new URLSearchParams({ titleKey: target?.titleKey ?? '' });
  if (target?.season !== undefined) params.set('season', String(target.season));
  if (target?.number !== undefined) params.set('number', String(target.number));
  const path = `/queue/releases?${params}`;
  const { data, isError, isFetching: busy } = useQuery<{ asked: number; answered: number; releases: ReleaseRow[] }>({ queryKey: [path], enabled: Boolean(target) });
  useEffect(() => setError(''), [path]);

  function searchAgain() {
    setError('');
    // The query shows the error.
    queryClient.fetchQuery({ queryKey: [path], queryFn: () => api(`${path}&fresh=1`) }).catch(() => {});
  }

  async function grab(release: ReleaseRow) {
    setError('');
    try {
      const { started } = await api<{ started: string[] }>('/queue/releases/grab', { method: 'POST', body: { ...target, indexerId: release.indexerId, guid: release.guid } });
      queueNotice(started.length);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.message === 'release_rejected' ? t('This release cannot be taken: it breaks a safety check.') : t('The request did not complete.'));
    }
  }

  if (!target) return null;
  return (
    <Section
      title={t('Releases for {label}', { label })}
      actions={
        <>
          <Button variant="ghost" pending={busy} onClick={searchAgain}>
            {t('Search again')}
          </Button>
          <Button variant="ghost" autoFocus onClick={onClose}>
            {t('Close')}
          </Button>
        </>
      }
    >
      {(error || isError) && <Alert tone="danger">{error || t('The search did not complete.')}</Alert>}
      {busy && <Spinner label={t('Searching')} />}
      {data && (
        <p>{t('{answered} of {asked} indexers answered.', { answered: data.answered, asked: data.asked })}</p>
      )}
      {data && data.releases.length === 0 && <EmptyState>{t('The indexers have no release for this target.')}</EmptyState>}
      {data && (
        <List>
          {data.releases.map((release) => (
            <Row
              key={`${release.indexerId}:${release.guid}`}
              actions={
                release.overridable ? (
                  <Button variant={release.accepted ? 'primary' : 'ghost'} onClick={() => void grab(release)}>
                    {release.accepted ? t('Download') : t('Download anyway')}
                  </Button>
                ) : undefined
              }
            >
              <p>
                {release.kind === 'pack'
                  ? t('{title} (full season)', { title: release.title })
                  : release.kind === 'multi'
                    ? t('{title} (several episodes)', { title: release.title })
                    : release.title}
              </p>
              <p>
                {release.indexer} {formatBytes(release.sizeBytes)} {release.seeders === null ? t('seeders unknown') : t('{n} seeders', { n: release.seeders })}
              </p>
              <p>{release.accepted ? t('Fits the preset.') : release.rejections.map((r) => t(r.message)).join(' ')}</p>
              {!release.overridable && <p>{t('This release cannot be downloaded.')}</p>}
            </Row>
          ))}
        </List>
      )}
    </Section>
  );
}
