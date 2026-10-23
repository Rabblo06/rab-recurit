import { execFileSync } from 'node:child_process';

import { COMPOSE_FILE, COMPOSE_PROJECT } from './env';

/**
 * Operations on the DISPOSABLE compose project only (`crewflow-e2e`). Every call names that project explicitly; nothing
 * here can address the dev stack or any other container.
 */
function compose(args: string[], env: Record<string, string> = {}): string {
  const envFile = process.env.E2E_ENV_FILE;
  if (!envFile) throw new Error('E2E_ENV_FILE is required');
  return execFileSync('docker', ['compose', '-p', COMPOSE_PROJECT, '--env-file', envFile, '-f', COMPOSE_FILE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}

export function container(service: string): string {
  return `${COMPOSE_PROJECT}-${service}-1`;
}

export function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
}

export function health(service: string): string {
  return docker(['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container(service)]).trim();
}

/**
 * Waits for Docker's health status 'healthy'. With `startedAfterMs`, a container that has not (re)started since then
 * does not count — a just-restarted container can briefly still report the previous run's state.
 */
export async function waitHealthy(service: string, timeoutMs = 180_000, startedAfterMs?: number): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    let h = '';
    try {
      h = health(service);
      if (startedAfterMs !== undefined) {
        const started = Date.parse(docker(['inspect', '-f', '{{.State.StartedAt}}', container(service)]).trim());
        if (!(started >= startedAfterMs - 2000)) h = `not-restarted-yet(${h})`;
      }
    } catch {
      h = 'missing';
    }
    if (h === 'healthy') return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${service} not healthy after ${timeoutMs} ms (${h})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Recreates server (+ worker) with env overrides (e.g. E2E_GOOGLE_ENABLED=true) and waits for health. */
export async function recreate(services: string[], env: Record<string, string>): Promise<Record<string, number>> {
  const t0 = Date.now();
  compose(['up', '-d', '--no-deps', '--force-recreate', ...services], env);
  const out: Record<string, number> = {};
  for (const s of services) out[s] = (await waitHealthy(s, 180_000, t0)) + (Date.now() - t0);
  return out;
}

export function stop(service: string): void {
  docker(['stop', '-t', '30', container(service)]);
}

export function start(service: string): void {
  docker(['start', container(service)]);
}

export function restart(service: string): void {
  docker(['restart', '-t', '55', container(service)]);
}

/** Non-blocking docker restart (the test keeps sending requests while the container restarts). */
export function restartAsync(service: string, graceSeconds = 55): Promise<void> {
  return new Promise((resolve, reject) => {
    require('node:child_process').execFile('docker', ['restart', '-t', String(graceSeconds), container(service)], { timeout: 300_000 }, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

export function pause(service: string): void {
  docker(['pause', container(service)]);
}

export function unpause(service: string): void {
  docker(['unpause', container(service)]);
}

export function logsSince(service: string, since: string): string {
  return execFileSync('docker', ['logs', '--since', since, container(service)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\x1b\[[0-9;]*m/g, '');
}

export function logsSinceAll(service: string, since: string): string {
  // stdout + stderr (Nest writes ERROR/WARN to stderr).
  const r = require('node:child_process').spawnSync('docker', ['logs', '--since', since, container(service)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
}
