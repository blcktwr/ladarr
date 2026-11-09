import type { AuthStatus } from '@ladarr/shared/types';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Db } from './db.ts';

const COOKIE = 'ladarr_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

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

// shortcut: failures live in process memory, so a restart clears them. Move them into the database file if that matters.
const failures = new Map<string, number[]>();

function throttleWait(key: string) {
  const recent = (failures.get(key) ?? []).filter((t) => Date.now() - t < FAILURE_WINDOW_MS);
  failures.set(key, recent);
  return recent.length >= MAX_FAILURES ? Math.ceil((recent[0]! + FAILURE_WINDOW_MS - Date.now()) / 1000) : 0;
}

function parsePassword(body: unknown) {
  const { password } = (body ?? {}) as Record<string, unknown>;
  if (typeof password !== 'string' || password.length < 4 || password.length > 128) return;
  return password;
}

function findSession(db: Db, req: Request) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return;
  const tokenHash = sha256(raw);
  const session = db.data.sessions[tokenHash];
  return session && session.expiresAt > Date.now() ? { tokenHash, ...session } : undefined;
}

async function startSession(db: Db, req: Request, res: Response) {
  const raw = newToken();
  const now = Date.now();
  for (const [tokenHash, session] of Object.entries(db.data.sessions)) {
    if (session.expiresAt < now) delete db.data.sessions[tokenHash];
  }
  db.data.sessions[sha256(raw)] = { csrfToken: newToken(), createdAt: now, expiresAt: now + SESSION_MS };
  await db.write();
  res.cookie(COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: req.baseUrl.replace(/\/api\/auth$/, '') || '/',
    maxAge: SESSION_MS,
  });
}

// A request passes with the session cookie, or with the API key in X-Api-Key when the route allows it.
export function requireAuth(db: Db, { allowApiKey = true } = {}): RequestHandler {
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

// Login and setup have no session yet. A JSON body keeps a cross-site form from posting to them.
const jsonOnly: RequestHandler = (req, res, next) =>
  req.is('application/json') ? next() : void res.status(415).json({ error: 'json_required' });

export function authRouter(db: Db) {
  const router = Router();

  router.get('/status', (req, res) => {
    const session = findSession(db, req);
    res.json({
      setupRequired: !db.data.owner,
      authenticated: Boolean(session),
      csrfToken: session?.csrfToken,
    } satisfies AuthStatus);
  });

  router.post('/setup', jsonOnly, async (req, res) => {
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
  });

  router.post('/login', jsonOnly, async (req, res) => {
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
    await startSession(db, req, res);
    res.json({ ok: true });
  });

  router.post('/logout', requireAuth(db), async (req, res) => {
    delete db.data.sessions[res.locals.session.tokenHash];
    await db.write();
    res.clearCookie(COOKIE, { path: req.baseUrl.replace(/\/api\/auth$/, '') || '/' });
    res.json({ ok: true });
  });

  // Only the owner session reads or rotates the key. The key cannot do it for itself.
  const sessionOnly = requireAuth(db, { allowApiKey: false });

  router.get('/api-key', sessionOnly, async (_req, res) => {
    if (!db.data.apiKey) {
      // The owner was made before keys existed.
      db.data.apiKey = newToken();
      await db.write();
    }
    res.json({ apiKey: db.data.apiKey });
  });

  router.post('/api-key/rotate', sessionOnly, async (_req, res) => {
    const previous = db.data.apiKey;
    db.data.apiKey = newToken();
    try {
      await db.write();
    } catch (err) {
      db.data.apiKey = previous;
      throw err;
    }
    res.json({ apiKey: db.data.apiKey });
  });

  return router;
}
