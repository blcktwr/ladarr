import { db } from '../../../core/db.ts';
import type { AuthStatus } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { findSession } from '../../../core/auth.ts';

export function authStatus(): RequestHandler {
  return (req, res) => {
    const session = findSession(req);
    res.json({
      setupRequired: !db.data.owner,
      authenticated: Boolean(session),
      csrfToken: session?.csrfToken,
    } satisfies AuthStatus);
  };
}
