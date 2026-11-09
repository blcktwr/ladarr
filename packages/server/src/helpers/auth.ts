import type { RequestHandler } from 'express';

// Login and setup have no session yet. A JSON body keeps a cross-site form from posting to them.
export const jsonOnly: RequestHandler = (req, res, next) =>
  req.is('application/json') ? next() : void res.status(415).json({ error: 'json_required' });

export function parsePassword(body: unknown) {
  const { password } = (body ?? {}) as Record<string, unknown>;
  if (typeof password !== 'string' || password.length < 4 || password.length > 128) return;
  return password;
}
