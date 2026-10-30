import { forbiddenRuntimeEnvNames, RuntimeProcessName } from '@rab/server/database/typeorm/core/never-in-runtime-env';

/**
 * The parent (Jest) environment minus every name a runtime process refuses to start with (security review L-4,
 * never-in-runtime-env.ts). CI exports DB_TARGET and the role bootstrap passwords job-wide for the harness and the
 * fixtures; a spawned API / Worker / provisioner must not inherit them, exactly as the Worker bundle launcher never
 * forwards them in a deployment. A test that sets one of these names on purpose (to prove the refusal) spreads it AFTER
 * this base.
 */
export function runtimeChildBaseEnv(
  env: NodeJS.ProcessEnv = process.env,
  processName: RuntimeProcessName = 'provisioner',
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { ...env };
  for (const name of forbiddenRuntimeEnvNames(processName)) delete base[name];
  return base;
}
