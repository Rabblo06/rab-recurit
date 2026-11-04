import { spawnSync } from 'node:child_process';

import {
  resolveWatchdogStaleMs,
  startEventLoopWatchdog,
  WATCHDOG_THREAD_SOURCE,
  WatchdogConfigError,
} from './event-loop-watchdog';

/**
 * The Worker's off-main-thread watchdog (owner-login architecture: no launcher). Real threads in a real child process: a
 * blocked event loop is SIGKILLed; a live one never is; PID 1 is refused because the kernel would ignore the kill there.
 */
function runChild(body: string, timeoutMs = 20_000) {
  // The child builds the watchdog exactly like startEventLoopWatchdog does (same thread source, shared timestamp, beat).
  const script = `
const { Worker } = require('node:worker_threads');
const sab = new SharedArrayBuffer(8);
const last = new BigInt64Array(sab);
const beat = () => Atomics.store(last, 0, BigInt(Date.now()));
beat();
const thread = new Worker(${JSON.stringify(WATCHDOG_THREAD_SOURCE)}, { eval: true, env: {}, workerData: { sab, staleMs: 800, checkMs: 100 } });
thread.unref();
setInterval(beat, 100).unref();
${body}`;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: timeoutMs });
}

describe('event-loop watchdog (Worker, no launcher)', () => {
  it('a blocked event loop is SIGKILLed by the thread, with one stderr line naming the stall', () => {
    const r = runChild(`setTimeout(() => { const t = Date.now(); while (Date.now() - t < 10000) {} console.log('survived'); }, 300);`);
    // POSIX (CI, the container): killed by SIGKILL. Windows has no signals: the process is terminated with a non-zero status.
    if (process.platform === 'win32') expect(r.status).not.toBe(0);
    else expect(r.signal).toBe('SIGKILL');
    expect(r.stdout).not.toContain('survived');
    expect(r.stderr).toMatch(/\[worker-watchdog\] the event loop has not beaten for \d+ s \(limit \d+ s\): killing the Worker/);
  });

  it('a live event loop (busy with async work, never blocked past the limit) is never killed', () => {
    const r = runChild(`let n = 0; const i = setInterval(() => { const t = Date.now(); while (Date.now() - t < 200) {} if (++n === 10) { clearInterval(i); console.log('done'); } }, 50);`);
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('done');
  });

  it('refuses to start as PID 1 (the kernel ignores the kill there): run the container with init: true', () => {
    expect(() => startEventLoopWatchdog({ staleMs: 120_000, pid: 1 })).toThrow(WatchdogConfigError);
    expect(() => startEventLoopWatchdog({ staleMs: 120_000, pid: 1 })).toThrow(/init: true/);
  });

  it('refuses a stale limit shorter than three beats; starts and stops cleanly otherwise', async () => {
    expect(() => startEventLoopWatchdog({ staleMs: 1_000, beatMs: 500 })).toThrow(/at least three beats/);
    const watchdog = startEventLoopWatchdog({ staleMs: 60_000, beatMs: 1_000 });
    await expect(watchdog.stop()).resolves.toBeUndefined();
  });

  it('CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS: whole seconds 30..900, default 120; anything else refuses', () => {
    expect(resolveWatchdogStaleMs({})).toBe(120_000);
    expect(resolveWatchdogStaleMs({ CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS: '' })).toBe(120_000);
    expect(resolveWatchdogStaleMs({ CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS: '30' })).toBe(30_000);
    expect(resolveWatchdogStaleMs({ CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS: '900' })).toBe(900_000);
    for (const bad of ['29', '901', '0', '60s', ' 60', '1e2', '-5']) {
      expect(() => resolveWatchdogStaleMs({ CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS: bad })).toThrow(WatchdogConfigError);
    }
  });
});
