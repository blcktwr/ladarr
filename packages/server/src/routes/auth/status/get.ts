import type { AuthStatus } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { findSession } from '../../../core/auth.ts';
import type { Db } from '../../../core/db.ts';

export function authStatus(db: Db): RequestHandler {
  return (req, res) => {
    const session = findSession(db, req);
    res.json({
      setupRequired: !db.data.owner,
      authenticated: Boolean(session),
      csrfToken: session?.csrfToken,
    } satisfies AuthStatus);
  };
}
