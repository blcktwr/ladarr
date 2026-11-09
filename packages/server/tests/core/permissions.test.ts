import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { firstUnwritable } from '../../src/core/permissions.ts';

const dir = mkdtempSync(join(tmpdir(), 'ladarr-perm-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('firstUnwritable', () => {
  it('skips a path that does not exist and a path that ladarr can write', () => {
    const file = join(dir, 'db.json');
    writeFileSync(file, '{}');
    expect(firstUnwritable([join(dir, 'missing'), dir, file])).toBeUndefined();
  });

  // Root can write to every file, so this case has no meaning for root.
  it.skipIf(process.getuid?.() === 0)('returns the first path that ladarr cannot write', () => {
    const file = join(dir, 'locked.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o444);
    expect(firstUnwritable([dir, file, join(dir, 'after')])).toBe(file);
  });
});
