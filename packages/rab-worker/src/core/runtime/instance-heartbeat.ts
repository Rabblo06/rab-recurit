import * as fs from 'node:fs';
import * as path from 'node:path';

import { WorkerRuntime } from './worker-runtime';

/**
 * Optional per-instance heartbeat FILE, enabled only when `CREWFLOW_INSTANCE_HEALTH_FILE` names an absolute path.
 * Unset (every standalone deployment, `yarn start`, the integration suites) → a no-op, and behaviour is unchanged.
 *
 * Why it exists: the Worker bundle (packages/rab-docker/rab/start-worker-bundle.cjs) runs the ordinary jobs process and
 * the workspace provisioner as two OS processes in one container. Its health check must cover BOTH roles in THIS
 * instance, but the existing Redis heartbeats (`rab:worker:heartbeat`, `rab:workspace-provisioner:heartbeat`,
 * `rab:worker:stats`) are global keys: any other healthy replica refreshes them, so a hung or dead child here would be
 * masked. A file in this container's own filesystem cannot be refreshed by another replica.
 *
 * Contents are timestamps and loop names only — no configuration, URL, credential or business data. The file is written
 * atomically (temp file + rename) into a directory only this process's UID can write; the bundle's health check and
 * watchdog read it. A write failure is swallowed: a missing or stale file makes the health check fail, which is the
 * correct signal, and it must never break a job cycle.
 *
 * `beat()` is called from the existing heartbeat interval, independently of Redis, so a Redis outage shows up as a stale
 * `redisOkAt` (dependency failure, reported) rather than a stale `at` (a hung process).
 */
export const INSTANCE_HEALTH_FILE_ENV = 'CREWFLOW_INSTANCE_HEALTH_FILE';

export interface InstanceHeartbeat {
  /** Records that this process's event loop is alive, with its current loop progress. */
  beat(): void;
  /** Records that this process's own Redis heartbeat write just succeeded. */
  markRedisOk(): void;
}

export function createInstanceHeartbeat(
  role: 'jobs' | 'provisioner',
  runtime: WorkerRuntime,
  env: Record<string, string | undefined> = process.env,
): InstanceHeartbeat {
  const file = env[INSTANCE_HEALTH_FILE_ENV]?.trim();
  if (!file) return { beat: () => undefined, markRedisOk: () => undefined };
  if (!path.isAbsolute(file)) throw new Error(`${INSTANCE_HEALTH_FILE_ENV} must be an absolute path.`);

  const tmp = `${file}.${process.pid}.tmp`;
  let redisOkAt: number | null = null;
  const write = (): void => {
    const body = JSON.stringify({ v: 1, role, pid: process.pid, at: Date.now(), redisOkAt, ...runtime.progress() });
    try {
      fs.writeFileSync(tmp, body, { mode: 0o644 });
      fs.renameSync(tmp, file);
    } catch {
      // Best-effort — see this file's doc comment.
    }
  };
  return {
    beat: write,
    markRedisOk: () => {
      redisOkAt = Date.now();
      write();
    },
  };
}
