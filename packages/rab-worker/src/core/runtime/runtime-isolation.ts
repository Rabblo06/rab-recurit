import * as fs from 'node:fs';

/**
 * Docker hardening H6, ported into the Worker (owner-login architecture: no root launcher, which used to run this check).
 * The same report api-prestart.sh prints for the API, for the container isolation THIS process actually received:
 * uid 1000, no capability in the bounding set, no-new-privileges, a read-only root filesystem, PID and memory limits.
 * Names and flags only; no value from the environment is printed.
 *
 * CREWFLOW_RUNTIME_ISOLATION (owner decision "never drop a security setting silently"; strict values):
 *   unset / empty / warn  one line ("as declared", or a WARNING naming each gap) and start anyway;
 *   enforce               any gap (an unreadable value included) REFUSES to start;
 *   anything else         refuses to start.
 * Outside Linux (a developer's `yarn start` on Windows or macOS) there is no container to report on: warn mode says so in
 * one line; enforce refuses, because nothing can be verified.
 */
export const RUNTIME_ISOLATION_ENV = 'CREWFLOW_RUNTIME_ISOLATION';
export const EXPECTED_UID = 1000;

export class RuntimeIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeIsolationError';
  }
}

export interface IsolationFacts {
  platform: string;
  uid: number | null;
  capBnd: string | null;
  noNewPrivs: string | null;
  /** Mount options of `/`, or null when unreadable. */
  rootOptions: string | null;
  pidsMax: string | null;
  memoryMax: string | null;
}

function read(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function readIsolationFacts(): IsolationFacts {
  const status = read('/proc/self/status') ?? '';
  const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status)?.[1] ?? null;
  const mounts = read('/proc/self/mounts');
  let rootOptions: string | null = null;
  for (const line of mounts?.split('\n') ?? []) {
    const parts = line.split(' ');
    if (parts[1] === '/') rootOptions = parts[3] ?? null; // the last "/" entry wins, as in api-prestart.sh
  }
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    capBnd: field('CapBnd'),
    noNewPrivs: field('NoNewPrivs'),
    rootOptions,
    pidsMax: read('/sys/fs/cgroup/pids.max')?.trim() ?? null,
    memoryMax: read('/sys/fs/cgroup/memory.max')?.trim() ?? null,
  };
}

export interface IsolationReport {
  mode: 'warn' | 'enforce';
  gaps: string[];
  summary: string;
}

export function assessRuntimeIsolation(env: Record<string, string | undefined>, facts: IsolationFacts): IsolationReport {
  const raw = env[RUNTIME_ISOLATION_ENV] ?? '';
  const mode = raw === '' || raw === 'warn' ? 'warn' : raw === 'enforce' ? 'enforce' : null;
  if (mode === null) throw new RuntimeIsolationError(`${RUNTIME_ISOLATION_ENV} must be "warn" or "enforce" (unset or empty = warn). Refusing to start.`);
  if (facts.platform !== 'linux') {
    return { mode, gaps: [`not a Linux container (${facts.platform}): nothing to verify`], summary: `platform=${facts.platform} mode=${mode}` };
  }
  const root = facts.rootOptions === null ? 'unknown' : `,${facts.rootOptions},`.includes(',ro,') ? 'read-only' : 'writable';
  const gaps: string[] = [];
  if (facts.uid === 0) gaps.push('running as root');
  else if (facts.uid !== EXPECTED_UID) gaps.push(`uid ${facts.uid ?? 'unknown'}, expected ${EXPECTED_UID}`);
  if (facts.capBnd !== '0000000000000000') gaps.push(`capabilities in the bounding set (CapBnd=${facts.capBnd ?? 'unknown'})`);
  if (facts.noNewPrivs !== '1') gaps.push('no-new-privileges is off');
  if (root !== 'read-only') gaps.push(`root filesystem is ${root}`);
  if (facts.pidsMax === 'max') gaps.push('no PID limit');
  else if (!facts.pidsMax) gaps.push('PID limit unreadable');
  if (facts.memoryMax === 'max') gaps.push('no memory limit');
  else if (!facts.memoryMax) gaps.push('memory limit unreadable');
  const summary =
    `uid=${facts.uid ?? 'unknown'} CapBnd=${facts.capBnd ?? 'unknown'} NoNewPrivs=${facts.noNewPrivs ?? 'unknown'} root=${root} ` +
    `pids.max=${facts.pidsMax || 'unknown'} memory.max=${facts.memoryMax || 'unknown'} mode=${mode}`;
  return { mode, gaps, summary };
}

/** Logs the one report line; throws RuntimeIsolationError in enforce mode when anything is missing. */
export function enforceRuntimeIsolation(
  env: Record<string, string | undefined>,
  log: { log(line: string): void; warn(line: string): void },
  facts: IsolationFacts = readIsolationFacts(),
): IsolationReport {
  const report = assessRuntimeIsolation(env, facts);
  if (report.gaps.length === 0) {
    log.log(`[worker-isolation] runtime isolation as declared: ${report.summary}`);
  } else if (report.mode === 'enforce') {
    throw new RuntimeIsolationError(
      `runtime isolation weaker than declared and ${RUNTIME_ISOLATION_ENV}=enforce (${report.gaps.join('; ')}): ${report.summary}. Refusing to start.`,
    );
  } else {
    log.warn(
      `[worker-isolation] WARNING runtime isolation weaker than declared (${report.gaps.join('; ')}): ${report.summary} - starting anyway; report it (THREAT-MODEL.md, Docker hardening H6)`,
    );
  }
  return report;
}
