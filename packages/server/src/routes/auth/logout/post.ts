import type { RequestHandler } from 'express';
import { SESSION_COOKIE, cookiePath } from '../../../core/auth.ts';
import type { Db } from '../../../core/db.ts';

export function authLogout(db: Db): RequestHandler {
  return async (req, res) => {
    delete db.data.sessions[res.locals.session.tokenHash];
    await db.write();
    res.clearCookie(SESSION_COOKIE, { path: cookiePath(req) });
    res.json({ ok: true });
  };
}
