import { get } from '../../../core/db.ts';
import { hash } from '@node-rs/argon2';
import type { RequestHandler } from 'express';
import { findSession, newToken, safeEqual, startSession } from '../../../core/auth.ts';
import { parsePassword } from '../../../helpers/auth.ts';

export function authSetup(): RequestHandler {
  const db = get();
  return async (req, res) => {
    const password = parsePassword(req.body);
    if (!password) return void res.status(400).json({ error: 'invalid_credentials_format' });
    const passwordHash = await hash(password);
    // Check and set run in one tick, so only one of many concurrent requests creates the owner.
    if (db.data.owner) {
      // The Back button of the setup returns to the password form while the setup is not complete.
      if (db.data.settings.setupCompleted) return void res.status(409).json({ error: 'setup_closed' });
      const session = findSession(db, req);
      if (!session) return void res.status(409).json({ error: 'setup_closed' });
      if (!safeEqual(req.get('x-csrf-token') ?? '', session.csrfToken)) return void res.status(403).json({ error: 'invalid_csrf_token' });
      db.data.owner.passwordHash = passwordHash;
      await db.write();
      return void res.json({ ok: true });
    }
    db.data.owner = { passwordHash, createdAt: Date.now() };
    db.data.apiKey = newToken();
    try {
      await startSession(db, req, res);
    } catch (err) {
      db.data.owner = null;
      db.data.apiKey = null;
      throw err;
    }
    res.status(201).json({ ok: true });
  };
}
