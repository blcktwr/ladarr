import type { RenameOverview } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import { PlanError } from '../../../library/imports/plan.ts';
import { planRename } from '../../../library/rename.ts';
import { fail, isObject, templatesOf } from '../../../helpers/rename.ts';

// The titles that new templates would change, with the count of files that change and the count that are blocked.
export function renameOverview(db: Db): RequestHandler {
  return async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const naming = templatesOf(db, body);
    if ('invalid' in naming) return void res.status(400).json({ error: 'invalid_template', field: naming.invalid });
    const titles: { titleKey: string; title: string; year: number | null; rename: number; blocked: number }[] = [];
    const withFiles = new Set(Object.values(db.data.files).map((file) => file.titleKey));
    for (const title of Object.values(db.data.titles)) {
      if (!withFiles.has(title.key)) continue;
      try {
        const { rows } = await planRename(db, title.key, naming);
        const rename = rows.filter((row) => row.status === 'rename').length;
        const blocked = rows.filter((row) => row.status === 'blocked').length;
        if (rename || blocked) titles.push({ titleKey: title.key, title: title.meta.title, year: title.meta.year, rename, blocked });
      } catch (error) {
        // A root that is not available gives no answer for its titles. The other titles go on.
        if (!(error instanceof PlanError)) throw error;
      }
    }
    titles.sort((a, b) => a.title.localeCompare(b.title));
    res.json({ titles: titles.slice(0, 200), total: titles.length } satisfies RenameOverview);
  };
}
