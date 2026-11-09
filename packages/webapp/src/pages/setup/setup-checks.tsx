import type { ClientView, IndexerRow } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { Button, Pane, Text } from 'nebula';
import { DownloadClients } from '../settings/connections-settings.tsx';
import { Indexers } from '../settings/indexer-settings.tsx';
import { t } from '../../i18n/index.ts';
import logo from '../../assets/logo.svg';

// The step of the setup after the library folders: the indexers and the download client.
// The user continues only with an indexer and an enabled download client, as the queue needs both.
export function SetupConnections({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const indexers = useQuery<{ indexers: IndexerRow[] }>({ queryKey: ['/indexers'] });
  const clients = useQuery<{ clients: ClientView[] }>({ queryKey: ['/clients'] });
  const ready = (indexers.data?.indexers.length ?? 0) > 0 && (clients.data?.clients.some((client) => client.enabled) ?? false);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 py-8">
      <img src={logo} alt="Ladarr" width={64} height={64} />
      <Text variant="title" className="w-[min(56rem,calc(100%-40px))]">{t('Connect the clients')}</Text>
      <Pane className="w-[min(56rem,calc(100%-40px))]">
        <Indexers />
      </Pane>
      <Pane className="w-[min(56rem,calc(100%-40px))]">
        <DownloadClients />
      </Pane>
      <div className="flex w-[min(56rem,calc(100%-40px))] items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack}>
          {t('Back')}
        </Button>
        <Button disabled={!ready} title={ready ? undefined : t('Indexer and download client required')} onClick={onContinue}>{t('Continue')}</Button>
      </div>
    </div>
  );
}
