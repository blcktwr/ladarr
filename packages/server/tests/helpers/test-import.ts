import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { link } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { episode, title } from './test-fixtures.ts';
import { startPipeline, until } from './test-pipeline.ts';

// A pipeline with a series of three episodes, a folder with files to import, and the HTTP app.
export async function startImportTest(options: Parameters<typeof startPipeline>[0] = {}) {
  const pipe = await startPipeline(options);
  const api = await pipe.api();
  const show = title({ rootId: 'tv', episodes: [1, 2, 3].map((n) => episode(1, n, `2020-01-0${n}`)) });
  pipe.db.data.titles[show.key] = show;
  const inbox = join(pipe.dir, 'inbox');
  mkdirSync(inbox);

  const write = (base: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(base, rel)), { recursive: true });
      writeFileSync(join(base, rel), content);
    }
  };
  // A file that the library has already, with its record.
  const addFile = (path: string, content: string, episodes: { season: number; number: number }[]) => {
    write(pipe.folders.tv, { [path]: content });
    const id = `file-${Object.keys(pipe.db.data.files).length + 1}`;
    const info = statSync(join(pipe.folders.tv, path));
    pipe.db.data.files[id] = { id, titleKey: show.key, path, sizeBytes: info.size, mtimeMs: info.mtimeMs, episodes, missing: false, addedAt: 0 };
    // An episode that the title does not have gives a file that no episode points to.
    for (const c of episodes) {
      const target = show.episodes.find((e) => e.season === c.season && e.number === c.number);
      if (target) target.fileId = id;
    }
    return id;
  };
  // Waits for the end of a run that the API started.
  const finished = (id: string) => until(() => pipe.importStatus.run(id)?.finished && !pipe.db.data.imports[id]);
  // All the files under a folder, relative to it, with the hidden ones.
  const tree = (base: string, dir = ''): string[] =>
    readdirSync(join(base, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? tree(base, join(dir, entry.name)) : [join(dir, entry.name)]));

  return {
    pipe,
    api,
    show,
    inbox,
    write,
    addFile,
    finished,
    tree,
    async stop() {
      api.close();
      await pipe.stop();
    },
  };
}

// A link that fails like a link between two disks, for the staged files only.
export const noLink = (code: string) => async (source: import('node:fs').PathLike, target: import('node:fs').PathLike) => {
  if (basename(String(target)).startsWith('.ladarr-')) throw Object.assign(new Error('no link'), { code });
  return link(source, target);
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
