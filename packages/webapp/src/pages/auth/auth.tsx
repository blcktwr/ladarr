import type { AuthStatus } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useId, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api, ApiError, setCsrfToken } from '../../lib/api.ts';
import { Button, Field, Form, Pane, Spinner, Text } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { RestoreFile } from '../settings/restore.tsx';
import { labels } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import logo from '../../assets/logo.svg';

const AuthContext = createContext<{ logout: () => Promise<void>; editAccess: () => void }>({ logout: async () => {}, editAccess: () => {} });
export const useAuth = () => useContext(AuthContext);

const messages: Record<string, string> = labels({
  invalid_credentials: 'The password is wrong.',
  too_many_attempts: 'Too many attempts. Try again later.',
  setup_closed: 'Setup is already complete. Reload the page to sign in.',
  setup_required: 'Setup is not complete. Reload the page to create the owner.',
  invalid_credentials_format: 'Use a password of 4 to 128 characters.',
});

function CredentialsForm({ setup, restore, onDone }: { setup: boolean; restore?: '/setup/restore' | '/backups/restore'; onDone: () => void }) {
  const formId = useId();
  const [error, setError] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [lengthError, setLengthError] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const { password, repeatPassword } = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setError('');
    const invalidLength = password.length < 4 || password.length > 128;
    setLengthError(invalidLength);
    if (invalidLength) return;
    if (setup && password !== repeatPassword) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setPending(true);
    try {
      await api(setup ? '/auth/setup' : '/auth/login', { method: 'POST', body: { password } });
      onDone();
    } catch (err) {
      setError(messages[(err as ApiError).message] ?? t('The request did not complete. Try again.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <img src={logo} alt="Ladarr" width={64} height={64} />
      <Text variant="title" className="w-[min(24rem,calc(100%-40px))]">{setup ? t("Let's start") : t('Sign in')}</Text>
      <Pane className="w-[min(24rem,calc(100%-40px))]">
        {error && <Alert tone="danger">{error}</Alert>}
        <Form id={formId} onSubmit={submit}>
          <Field width="full" label={t('Password')} name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} aria-required="true" error={lengthError ? t('Use a password of 4 to 128 characters.') : undefined} onValueChange={() => { setLengthError(false); setMismatch(false); }} />
          {setup && (
            <Field width="full" label={t('Repeat password')} name="repeatPassword" type="password" autoComplete="new-password" aria-required="true" error={mismatch ? t('The passwords do not match.') : undefined} onValueChange={() => setMismatch(false)} />
          )}
        </Form>
      </Pane>
      <div className={`flex w-[min(24rem,calc(100%-40px))] ${restore ? 'justify-between' : 'justify-end'} gap-2`}>
        {restore && <RestoreFile setup route={restore} />}
        <Button type="submit" form={formId} pending={pending}>
          {setup ? t('Set password') : t('Sign in')}
        </Button>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [editingAccess, setEditingAccess] = useState(false);
  const { pathname } = useLocation();
  const { data: status, error, refetch } = useQuery({
    queryKey: ['/auth/status'],
    queryFn: async () => {
      const next = await api<AuthStatus>('/auth/status');
      setCsrfToken(next.csrfToken ?? '');
      return next;
    },
  });

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST', body: {} });
    await refetch();
  }, [refetch]);

  if (error && !status) {
    return (
      <Pane>
        <Alert tone="danger">{t('The server does not answer. Reload the page to try again.')}</Alert>
      </Pane>
    );
  }
  if (!status) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label={t('Loading')} />
      </div>
    );
  }
  if (editingAccess || !status.authenticated) {
    const setup = editingAccess || status.setupRequired;
    // The first run is the setup, and it has its own address.
    if (setup && pathname !== '/setup') return <Navigate to="/setup" replace />;
    return (
      <CredentialsForm
        setup={setup}
        restore={editingAccess ? '/backups/restore' : setup ? '/setup/restore' : undefined}
        onDone={() => {
          setEditingAccess(false);
          void refetch();
        }}
      />
    );
  }
  return <AuthContext value={{ logout, editAccess: () => setEditingAccess(true) }}>{children}</AuthContext>;
}
