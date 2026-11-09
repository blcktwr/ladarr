import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestHandler } from 'express';

export function backupDelete(dir: string): RequestHandler<{ name: string }> {
  return async (req, res) => {
    const file = join(dir, req.params.name);
    if (!(await stat(file).catch(() => undefined))) return void res.status(404).json({ error: 'not_found' });
    await rm(file);
    res.json({ ok: true });
  };
}
