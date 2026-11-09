import type { Request, RequestHandler, Response } from 'express';
import { BackupError, isBackupName } from '../system/backup.ts';
import { MAX_UPLOAD_BYTES, RestoreError, type Restorer } from '../system/restore.ts';

export const backupName: RequestHandler<{ name: string }> = (req, res, next) =>
  isBackupName(req.params.name) ? next() : void res.status(404).json({ error: 'not_found' });

export const sessionRequired: RequestHandler = (_req, res, next) => (res.locals.session ? next() : void res.status(403).json({ error: 'session_required' }));

// Reads the body of a request into memory, and stops at the limit.
async function readBody(req: Request, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The body is the backup file. The user sends a file that is not in the backup folder, for example from another machine.
export async function restoreUpload(restorer: Restorer, req: Request, res: Response) {
  if (!req.is(['application/zip', 'application/octet-stream'])) return void res.status(400).json({ error: 'invalid_archive' });
  // A refusal by size does not read the whole body, so the connection closes.
  const tooLarge = () => void res.set('Connection', 'close').status(413).json({ error: 'backup_too_large' });
  if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) return tooLarge();
  const body = await readBody(req, MAX_UPLOAD_BYTES).catch(() => null);
  if (body === undefined) return tooLarge();
  // A client that stops the upload leaves no complete file.
  if (!body?.length) return void res.status(400).json({ error: 'invalid_archive' });
  try {
    res.json({ ok: true, ...(await restorer.restore(body, res)) });
  } catch (error) {
    if (error instanceof BackupError) return void res.status(422).json({ error: error.code });
    if (error instanceof RestoreError) return void res.status(409).json({ error: error.code });
    throw error;
  }
}
