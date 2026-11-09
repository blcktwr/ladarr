import type { SettingsResponse } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Fragment, type ReactNode } from 'react';
import { Spinner } from 'nebula';
import { LoadFailed } from '../../components/load-failed.tsx';
import { t } from '../../i18n/index.ts';

// Loads the settings for one card. The key makes the card start again with the saved values after a reload.
export function WithSettings({ children }: { children: (data: SettingsResponse, reload: () => void) => ReactNode }) {
  const { data, error, isFetching: loading, refetch: reload } = useQuery<SettingsResponse>({ queryKey: ['/settings'] });
  if (error && !data) return <LoadFailed onRetry={reload} />;
  if (loading && !data) return <Spinner label={t('Loading')} />;
  return <Fragment key={JSON.stringify(data!.settings)}>{children(data!, reload)}</Fragment>;
}
