import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { get, type Db } from './db.ts';

export const SESSION_COOKIE = 'ladarr_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function findSession(db: Db, req: Request) {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return;
  const tokenHash = sha256(raw);
  const session = db.data.sessions[tokenHash];
  return session && session.expiresAt > Date.now() ? { tokenHash, ...session } : undefined;
}

// The cookie belongs to the whole app, also when the API sits under a URL base.
export const cookiePath = (req: Request) => req.baseUrl.replace(/\/api$/, '') || '/';

export async function startSession(db: Db, req: Request, res: Response) {
  const raw = newToken();
  const now = Date.now();
  for (const [tokenHash, session] of Object.entries(db.data.sessions)) {
    if (session.expiresAt < now) delete db.data.sessions[tokenHash];
  }
  db.data.sessions[sha256(raw)] = { csrfToken: newToken(), createdAt: now, expiresAt: now + SESSION_MS };
  await db.write();
  res.cookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: cookiePath(req),
    maxAge: SESSION_MS,
  });
}

// A request passes with the session cookie, or with the API key in X-Api-Key when the route allows it.
export function requireAuth({ allowApiKey = true } = {}): RequestHandler {
  const db = get();
  return (req, res, next) => {
    const key = req.get('x-api-key');
    if (allowApiKey && key && db.data.apiKey && safeEqual(key, db.data.apiKey)) return next();
    const session = findSession(db, req);
    if (!session) return void res.status(401).json({ error: 'unauthenticated' });
    const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!safeMethod && !safeEqual(req.get('x-csrf-token') ?? '', session.csrfToken)) {
      return void res.status(403).json({ error: 'invalid_csrf_token' });
    }
    res.locals.session = session;
    next();
  };
}
