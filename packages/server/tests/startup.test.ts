import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { emptyData } from '../src/core/db.ts';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ladarr-start-'));
afterAll(() => {
  if (existsSync(join(dir, 'locked'))) chmodSync(join(dir, 'locked'), 0o700);
  rmSync(dir, { recursive: true, force: true });
});

// Vitest sets NODE_ENV to "test", and then lowdb keeps the data in memory only.
const start = (configDir: string) => spawnSync(process.execPath, [entry], { env: { ...process.env, NODE_ENV: 'production', PORT: '0', LADARR_CONFIG_DIR: configDir, TMDB_API_KEY: '' }, encoding: 'utf8', timeout: 15_000 });

describe('start', () => {
  it('refuses a data file of a newer schema and leaves the file as it is', () => {
    const configDir = join(dir, 'newer');
    mkdirSync(configDir);
    const text = JSON.stringify({ ...emptyData(), schemaVersion: 99 });
    writeFileSync(join(configDir, 'db.json'), text);
    const result = start(configDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('schema version 99');
    expect(readFileSync(join(configDir, 'db.json'), 'utf8')).toBe(text);
  });

  // Root can write to every folder, so this case has no meaning for root.
  it.skipIf(process.getuid?.() === 0)('says which path it cannot write to', () => {
    const configDir = join(dir, 'locked');
    mkdirSync(configDir);
    chmodSync(configDir, 0o500);
    const result = start(configDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Cannot write to ${configDir}`);
  });
});
