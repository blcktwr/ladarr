import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { until } from '../helpers/test-pipeline.ts';

// The module that every harness below loads.
const supervisor = fileURLToPath(new URL('../../src/system/supervisor.ts', import.meta.url));

const base = mkdtempSync(join(tmpdir(), 'ladarr-supervisor-'));
// The fixtures are ESM, as the source of the package is.
writeFileSync(join(base, 'package.json'), '{"type":"module"}\n');
afterAll(() => rmSync(base, { recursive: true, force: true }));

const quote = (value: string) => JSON.stringify(value);

// The fake servers count their runs in a file and mark each one in it.
const prelude = `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const count = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\\n').filter(Boolean).length : 0);
const mark = (file) => appendFileSync(file, 'run ' + (count(file) + 1) + '\\n');
`;

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

type Options = { execPath?: string; stopTimeoutMs?: number };

// Writes a fake server and a harness that calls the supervisor on it. The server gets its own folder.
function writeCase(name: string, server: (dir: string) => string, options: Options = {}) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const serverFile = join(dir, 'server.ts');
  writeFileSync(serverFile, prelude + server(dir));
  const settings = [options.execPath === undefined ? '' : `execPath: ${quote(options.execPath)}`, options.stopTimeoutMs === undefined ? '' : `stopTimeoutMs: ${options.stopTimeoutMs}`]
    .filter(Boolean)
    .join(', ');
  const harnessFile = join(dir, 'harness.ts');
  writeFileSync(harnessFile, `import { supervise } from ${quote(supervisor)};\nsupervise(${quote(serverFile)}${settings ? `, { ${settings} }` : ''});\n`);
  return { dir, serverFile, harnessFile };
}

const running = new Set<ChildProcess>();

// Each supervisor gets a process group of its own, so the cleanup reaches the child of the supervisor too.
function start(args: string[]) {
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  running.add(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk));
  const exit = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      running.delete(child);
      resolve(code);
    }),
  );
  return { child, exit, stderr: () => stderr };
}

afterEach(() => {
  for (const child of running) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  running.clear();
});

describe('supervisor', () => {
  it('spawns the server again when it exits with the update code', async () => {
    const { dir, harnessFile } = writeCase(
      'restart',
      (dir) => `
const runs = ${quote(join(dir, 'runs.txt'))};
mark(runs);
process.exit(count(runs) === 1 ? 75 : 0);
`,
    );
    const child = start([harnessFile]);

    expect(await child.exit).toBe(0);
    expect(lines(join(dir, 'runs.txt'))).toEqual(['run 1', 'run 2']);
  }, 10_000);

  it('exits with the code of the server when it is not the update code', async () => {
    const { dir, harnessFile } = writeCase(
      'exit-code',
      (dir) => `
const runs = ${quote(join(dir, 'runs.txt'))};
mark(runs);
process.exit(3);
`,
    );
    const child = start([harnessFile]);

    expect(await child.exit).toBe(3);
    expect(lines(join(dir, 'runs.txt'))).toEqual(['run 1']);
  }, 10_000);

  it('exits with 1 when the server ends by a signal', async () => {
    const { dir, harnessFile } = writeCase(
      'signal',
      (dir) => `
const runs = ${quote(join(dir, 'runs.txt'))};
mark(runs);
process.kill(process.pid, 'SIGKILL');
`,
    );
    const child = start([harnessFile]);

    expect(await child.exit).toBe(1);
    expect(lines(join(dir, 'runs.txt'))).toEqual(['run 1']);
  }, 10_000);

  it('exits with 1 and writes to stderr when the server does not start', async () => {
    const { harnessFile } = writeCase('missing-exec', () => 'process.exit(0);\n', { execPath: join(base, 'no-such-node') });
    const child = start([harnessFile]);

    expect(await child.exit).toBe(1);
    expect(child.stderr()).not.toBe('');
  }, 10_000);

  // The server marks its start, and a stop signal makes it mark its stop and end with 0.
  const stoppable = (dir: string) => `
const starts = ${quote(join(dir, 'starts.txt'))};
const stops = ${quote(join(dir, 'stops.txt'))};
mark(starts);
process.on('SIGTERM', () => {
  appendFileSync(stops, 'stopped\\n');
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

  async function stopsOn(signal: NodeJS.Signals) {
    const { dir, harnessFile } = writeCase(`stop-${signal}`, stoppable, { stopTimeoutMs: 300 });
    const child = start([harnessFile]);
    await until(() => lines(join(dir, 'starts.txt')).length === 1);

    child.child.kill(signal);

    expect(await child.exit).toBe(0);
    expect(lines(join(dir, 'starts.txt'))).toEqual(['run 1']);
    expect(lines(join(dir, 'stops.txt'))).toEqual(['stopped']);
  }

  it('forwards SIGTERM to the server and does not start it again', async () => {
    await stopsOn('SIGTERM');
  }, 10_000);

  it('kills the server after the stop timeout when it ignores SIGTERM', async () => {
    const { dir, harnessFile } = writeCase(
      'stop-timeout',
      (dir) => `
const starts = ${quote(join(dir, 'starts.txt'))};
mark(starts);
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
      { stopTimeoutMs: 300 },
    );
    const child = start([harnessFile]);
    await until(() => lines(join(dir, 'starts.txt')).length === 1);

    const at = Date.now();
    child.child.kill('SIGTERM');

    expect(await child.exit).toBe(0);
    expect(Date.now() - at).toBeLessThan(5_000);
    expect(lines(join(dir, 'starts.txt'))).toEqual(['run 1']);
  }, 10_000);

  it('does not start another server when a stop signal arrives after an update', async () => {
    const { dir, harnessFile } = writeCase(
      'stop-after-restart',
      (dir) => `
const starts = ${quote(join(dir, 'starts.txt'))};
mark(starts);
if (count(starts) === 1) process.exit(75);
setInterval(() => {}, 1000);
`,
      { stopTimeoutMs: 300 },
    );
    const child = start([harnessFile]);
    await until(() => lines(join(dir, 'starts.txt')).length === 2);

    child.child.kill('SIGTERM');

    expect(await child.exit).toBe(0);
    expect(lines(join(dir, 'starts.txt'))).toEqual(['run 1', 'run 2']);
  }, 10_000);

  it.skipIf(process.platform !== 'linux')('forwards SIGPWR to the server and does not start it again', async () => {
    await stopsOn('SIGPWR');
  }, 10_000);

  it('spawns the server again for each update code it gets', async () => {
    const { dir, harnessFile } = writeCase(
      'consecutive',
      (dir) => `
const runs = ${quote(join(dir, 'runs.txt'))};
mark(runs);
process.exit(count(runs) < 3 ? 75 : 0);
`,
    );
    const child = start([harnessFile]);

    expect(await child.exit).toBe(0);
    expect(lines(join(dir, 'runs.txt'))).toEqual(['run 1', 'run 2', 'run 3']);
  }, 10_000);

  it('works as the command line entry point', async () => {
    const { dir, serverFile } = writeCase(
      'cli',
      (dir) => `
const runs = ${quote(join(dir, 'runs.txt'))};
mark(runs);
process.exit(count(runs) === 1 ? 75 : 0);
`,
    );
    const child = start([supervisor, serverFile]);

    expect(await child.exit).toBe(0);
    expect(lines(join(dir, 'runs.txt'))).toEqual(['run 1', 'run 2']);
  }, 10_000);
});
