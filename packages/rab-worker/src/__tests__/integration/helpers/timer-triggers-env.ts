/**
 * Phase D-Q4b integration suites: called from a side-effect helper the spec imports FIRST (the env is frozen when
 * AppModule is imported). Each suite gets its own Redis DB index.
 */
export function applyTimerTriggerEnv(mode: 'on' | 'off', redisDb: number): void {
  const baseRedis = process.env.REDIS_URL ?? 'redis://localhost:6379';
  process.env.REDIS_URL = `${baseRedis.replace(/\/\d+$/, '')}/${redisDb}`;
  if (mode === 'on') process.env.WORKER_TIMER_TRIGGERS = 'on';
  else delete process.env.WORKER_TIMER_TRIGGERS;
  delete process.env.WORKER_TIMER_TRIGGER_KINDS;
}
