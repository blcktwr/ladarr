import { Button, EmptyState } from 'nebula';
import { t } from '../i18n/index.ts';

// Nebula has no load error, so this is an EmptyState with a Button that tries again.
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      <EmptyState>{t('The request did not complete.')}</EmptyState>
      <Button variant="ghost" onClick={onRetry}>
        {t('Retry')}
      </Button>
    </>
  );
}
