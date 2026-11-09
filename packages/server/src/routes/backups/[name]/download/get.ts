import { join } from 'node:path';
import type { RequestHandler } from 'express';

export function backupDownload(dir: string): RequestHandler<{ name: string }> {
  return (req, res) => {
    res.download(join(dir, req.params.name), req.params.name, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not_found' });
    });
  };
}
