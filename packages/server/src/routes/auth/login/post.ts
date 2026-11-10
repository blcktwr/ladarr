import { get } from '../../../core/db.ts';
import { verify } from '@node-rs/argon2';
import type { RequestHandler } from 'express';
import { startSession } from '../../../core/auth.ts';
import { parsePassword } from '../../../helpers/auth.ts';

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// shortcut: failures live in process memory, so a restart clears them. Move them into the database file if that matters.
const failures = new Map<string, number[]>();

function throttleWait(key: string) {
  const recent = (failures.get(key) ?? []).filter((t) => Date.now() - t < FAILURE_WINDOW_MS);
  failures.set(key, recent);
  return recent.length >= MAX_FAILURES ? Math.ceil((recent[0]! + FAILURE_WINDOW_MS - Date.now()) / 1000) : 0;
}

export function authLogin(): RequestHandler {
  const db = get();
  return async (req, res) => {
    const key = req.ip ?? 'unknown';
    const wait = throttleWait(key);
    if (wait) return void res.set('Retry-After', String(wait)).status(429).json({ error: 'too_many_attempts' });

    const password = parsePassword(req.body);
    const { owner } = db.data;
    if (!owner) return void res.status(409).json({ error: 'setup_required' });
    // Verify even when the password is missing or has a bad format, so every failure takes the same time.
    const passwordOk = await verify(owner.passwordHash, password ?? '').catch(() => false);
    if (!password || !passwordOk) {
      failures.get(key)!.push(Date.now());
      return void res.status(401).json({ error: 'invalid_credentials' });
    }
    failures.delete(key);
    await startSession(req, res);
    res.json({ ok: true });
  };
}
