import { accessSync, constants } from 'node:fs';

// The first of these paths that exists and that this process cannot write to. A path that does not exist yet is not a problem.
export function firstUnwritable(paths: string[]): string | undefined {
  return paths.find((path) => {
    try {
      accessSync(path, constants.W_OK);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  });
}
