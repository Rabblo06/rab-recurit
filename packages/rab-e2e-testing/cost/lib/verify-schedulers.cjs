// Scheduler check for the disposable harness stacks (Phase X P0-H review fix 1). Under WORKER_SCHEDULER=bullmq the API
// registers the BullMQ job schedulers (api-prestart.sh -> register-schedulers.js) with ITS environment, and the
// consume-only Worker runs whatever is registered. A scan or dispatch setting given to the Worker only is therefore
// silently NOT what runs. The Worker's own boot check only reports MISSING ids; this script also fails on an UNEXPECTED
// Crewflow scheduler (registered but not enabled in the Worker's plan) and on an INTERVAL MISMATCH (registered `every`
// differs from the Worker's plan), so a measurement arm can never measure a configuration other than the one it names.
//
// Runs INSIDE the Worker container, with the Worker's own environment and compiled code (read-only; it never upserts or
// removes anything):
//   docker exec -i <worker container> node - < packages/rab-e2e-testing/cost/lib/verify-schedulers.cjs
// Prints one JSON line (ids and intervals only, never REDIS_URL). Exit 0 = registered schedule == the Worker's plan,
// 1 = a difference (listed), 2 = could not check.
'use strict';
const path = require('path');

const DIST = '/app/packages/rab-worker/dist';
const fromWorker = (id) => require(require.resolve(id, { paths: [DIST, '/app'] }));

(async () => {
  const { validate } = fromWorker('@rab/server/engine/core-modules/environment/env.validation');
  const { buildSchedulerPlan } = require(path.join(DIST, 'core/scheduler/scheduler-plan.js'));
  const { schedulerIdOf, crewflowSchedulerPrefixOf } = require(path.join(DIST, 'core/scheduler/scan-jobs.js'));
  const { Queue } = fromWorker('bullmq');
  const Redis = fromWorker('ioredis');

  const env = validate(process.env);
  const plan = buildSchedulerPlan({ get: (key) => env[key] });
  const expected = new Map();
  for (const def of plan.jobs) if (plan.isEnabled(def)) expected.set(schedulerIdOf(def), plan.intervalOf(def));

  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 10_000, retryStrategy: (n) => (n > 3 ? null : 1_000) });
  redis.on('error', () => undefined);
  const actual = new Map();
  try {
    for (const queueName of [...new Set(plan.jobs.map((d) => d.queue))]) {
      const queue = new Queue(queueName, { connection: redis, prefix: plan.prefix });
      try {
        for (const s of await queue.getJobSchedulers(0, -1, true)) {
          if (String(s.key).startsWith(crewflowSchedulerPrefixOf(queueName))) actual.set(s.key, Number(s.every));
        }
      } finally {
        await queue.close().catch(() => undefined);
      }
    }
  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }

  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  const unexpected = [...actual.keys()].filter((id) => !expected.has(id));
  const intervalMismatch = [...expected].filter(([id, ms]) => actual.has(id) && actual.get(id) !== ms).map(([id, ms]) => `${id} registered=${actual.get(id)}ms worker-plan=${ms}ms`);
  const ok = missing.length === 0 && unexpected.length === 0 && intervalMismatch.length === 0;
  console.log(
    JSON.stringify({
      ok,
      prefix: plan.prefix,
      shiftScanMode: plan.shiftScanMode,
      dispatch: { claimMode: plan.dispatchConfig?.claimMode, dispatchMode: plan.dispatchConfig?.dispatchMode },
      expected: Object.fromEntries([...expected].sort()),
      missing,
      unexpected,
      intervalMismatch,
    }),
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e).replace(/(redis|postgres(ql)?):\/\/\S+/g, '<url>').slice(0, 400) }));
  process.exit(2);
});
