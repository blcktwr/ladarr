import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const MAX_DEPTH = 6;

export type Listed = { path: string; sizeBytes: number };

// Lists the files under a folder, with paths relative to the folder and sorted. It follows no link to a folder.
// `truncated` is true when the limit or the depth cut the list short. A missing folder throws.
export async function listFiles(folder: string, limit: number): Promise<{ files: Listed[]; truncated: boolean }> {
  const files: Listed[] = [];
  let truncated = false;
  async function walk(dir: string, prefix: string, depth: number) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(join(dir, entry.name), path, depth + 1);
        else truncated = true;
      } else {
        const info = await lstat(join(dir, entry.name)).catch(() => undefined);
        if (info) files.push({ path, sizeBytes: info.size });
      }
    }
  }
  await walk(folder, '', 0);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated };
}
