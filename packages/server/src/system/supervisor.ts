import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UPDATE_EXIT_CODE } from './exit.ts';

export type SupervisorOptions = { execPath?: string; stopTimeoutMs?: number };

// The server of this build, next to the system folder.
const serverEntry = fileURLToPath(new URL('../index.ts', import.meta.url));
const STOP_TIMEOUT_MS = 30_000;

// Runs the server and starts it again after an update. The platform runs this process as PID 1,
// so a stop signal stops the server, waits for it, and ends this process.
export function supervise(server: string, { execPath = process.execPath, stopTimeoutMs = STOP_TIMEOUT_MS }: SupervisorOptions = {}) {
  let child: ChildProcess | undefined;
  let stopping = false;

  function start() {
    const running = spawn(execPath, [server], { stdio: 'inherit' });
    child = running;
    running.on('error', (error) => {
      console.error(`Cannot start the server: ${error.message}`);
      process.exit(1);
    });
    running.on('exit', (code, signal) => {
      child = undefined;
      if (stopping) return process.exit(0);
      // The update replaced the files and stopped the server. A stop of any other kind is a result to report.
      if (code === UPDATE_EXIT_CODE) return start();
      process.exit(code ?? (signal ? 1 : 0));
    });
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    child?.kill('SIGTERM');
    // The platform has its own limit. This one ends a server that does not stop by itself.
    setTimeout(() => child?.kill('SIGKILL'), stopTimeoutMs).unref();
  }

  // The stop of an LXC container is SIGPWR by default. Docker and a person use SIGTERM or SIGINT.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGPWR'] as const) {
    if (signal === 'SIGPWR' && process.platform !== 'linux') continue;
    process.on(signal, stop);
  }

  start();
}

if (import.meta.main) supervise(process.argv[2] ?? serverEntry);
