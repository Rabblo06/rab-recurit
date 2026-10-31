// Load test orchestrator (ported from the 2026-10-26 harness): autocannon from a container on the cost network,
// cgroup CPU deltas for api/pg/redis, peak DB connections by role, Redis commands per request, API memory peak.
// /offers/mine additionally gets a pg_stat_statements window (worker paused) for DB execution ms per request.
//   node lib/loadtest.js <label>     env: SCEN=name1,name2 (filter), DUR=30 (seconds), COST_LOADGEN_IMAGE (built by run.sh)
const { spawn } = require('child_process');
const { loginWeb, loginMobile, psql, redisInfo, cgroupUsec, cgroupMem, writeJson, dockerEnv, harnessDocker, HARNESS_LABEL_ARGS, sleep } = require('./lib');

const label = process.argv[2] || 'run';
const DUR = Number(process.env.DUR || 30);
const IMAGE = process.env.COST_LOADGEN_IMAGE; // crewflow-cost/loadgen:<hash> (tools/Dockerfile), no bind mounts at run time
if (!IMAGE) throw new Error('COST_LOADGEN_IMAGE not set');
const AC_CPUS = process.env.COST_AC_CPUS || '2';

function runAc(cfg) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['run', '--rm', ...HARNESS_LABEL_ARGS, '--network', 'crewflow-cost-net', `--cpus=${AC_CPUS}`, '--memory=256m', IMAGE, JSON.stringify(cfg)], { env: dockerEnv });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', () => { const m = /RESULT (.*)/.exec(out); m ? resolve(JSON.parse(m[1])) : reject(new Error(out.slice(-2000))); });
  });
}

(async () => {
  const mgr = await loginWeb('manager1@org01.example.test');
  const fileIds = psql(`select avatar_file_id from core."user" u join core.organisation o on o.id=u.organisation_id where o.slug='costaudit-01' and avatar_file_id is not null order by u.email`).split('\n');
  const notifIds = psql(`select n.id from core.notification n join core."user" u on u.id=n.user_id where u.email='staff01@org01.example.test' order by n.created_at, n.id`).split('\n');
  const webH = { cookie: mgr.cookie, origin: 'http://127.0.0.1:5173' };
  const scen = [
    { name: 'GET /dashboard/summary c=10', c: 10, path: '/rest/v1/dashboard/summary', auth: 'web' },
    { name: 'GET /dashboard/summary c=25', c: 25, path: '/rest/v1/dashboard/summary', auth: 'web' },
    { name: 'GET /dashboard/summary c=50', c: 50, path: '/rest/v1/dashboard/summary', auth: 'web' },
    { name: 'GET /shifts?limit=50 c=25', c: 25, path: '/rest/v1/shifts?limit=50', auth: 'web' },
    { name: 'GET /notifications/unread-count c=25', c: 25, path: '/rest/v1/notifications/unread-count', auth: 'web' },
    { name: 'GET /offers/mine (bearer) c=25', c: 25, path: '/rest/v1/offers/mine', auth: 'mobile', pgss: true },
    { name: 'GET /files/:id avatar c=25', c: 25, paths: fileIds.map((id) => `/rest/v1/files/${id}`), auth: 'web' },
    { name: 'POST /notifications/:id/read (bearer) c=10', c: 10, method: 'POST', paths: notifIds.map((id) => `/rest/v1/notifications/${id}/read`), auth: 'mobile' },
  ].filter((s) => !process.env.SCEN || process.env.SCEN.split(',').some((f) => s.name.includes(f)));

  const results = [];
  for (const s of scen) {
    const headers = s.auth === 'web' ? webH : { authorization: `Bearer ${(await loginMobile('staff01@org01.example.test')).bearer}`, 'x-client-platform': 'mobile' };
    // Worker paused for every load window: the API/DB numbers are then this traffic only (idle worker load is measured separately).
    harnessDocker('pause', 'costaudit-worker');
    try {
      if (s.pgss) psql('select pg_stat_statements_reset()');
      const cpu0 = { api: cgroupUsec('costaudit-api'), pg: cgroupUsec('costaudit-pg'), redis: cgroupUsec('costaudit-redis') };
      const r0 = redisInfo('stats');
      const t0 = Date.now();
      const peak = {}; let peakRedisMem = 0; let apiMemPeakMiB = 0;
      const sampler = setInterval(() => {
        try {
          for (const r of psql(`select usename||'='||count(*) from pg_stat_activity where datname='rab' and usename<>'rab' group by usename`).split('\n').filter(Boolean)) { const [u, n] = r.split('='); peak[u] = Math.max(peak[u] || 0, Number(n)); }
          peakRedisMem = Math.max(peakRedisMem, Number(redisInfo('memory').used_memory));
          const m = cgroupMem('costaudit-api'); if (m) apiMemPeakMiB = Math.max(apiMemPeakMiB, +(m / 1048576).toFixed(1));
        } catch { /* sampling is best effort */ }
      }, 3000);
      const ac = await runAc({ base: 'http://costaudit-api:3000', c: s.c, d: DUR, path: s.path, paths: s.paths, method: s.method || 'GET', headers });
      clearInterval(sampler);
      const secs = (Date.now() - t0) / 1000;
      const cpu1 = { api: cgroupUsec('costaudit-api'), pg: cgroupUsec('costaudit-pg'), redis: cgroupUsec('costaudit-redis') };
      const r1 = redisInfo('stats');
      const cpuPct = Object.fromEntries(Object.keys(cpu0).map((k) => [k, +(((cpu1[k] - cpu0[k]) / 1e6 / secs) * 100).toFixed(1)]));
      let pgss = null;
      if (s.pgss) {
        const [calls, ms] = psql(`select coalesce(sum(calls),0)||'|'||coalesce(round(sum(total_exec_time)::numeric,1),0) from pg_stat_statements where userid in ('crewflow_app'::regrole) and toplevel`).split('|').map(Number);
        const [ncalls, nms] = psql(`select coalesce(sum(calls),0)||'|'||coalesce(round(sum(total_exec_time)::numeric,1),0) from pg_stat_statements where userid='rab_secure_owner'::regrole`).split('|').map(Number);
        pgss = { toplevelStatements: calls, toplevelExecMs: ms, statementsPerRequest: +(calls / ac.requests).toFixed(2), dbExecMsPerRequest_toplevel: +(ms / ac.requests).toFixed(3), nestedDefinerStatementsPerRequest: +(ncalls / ac.requests).toFixed(2), nestedExecMs: nms,
          topStatementsByTime: psql(`select round(total_exec_time::numeric,1)||'ms|'||calls||'|'||left(regexp_replace(query,'\\s+',' ','g'),140) from pg_stat_statements where userid='crewflow_app'::regrole and toplevel order by total_exec_time desc limit 5`).split('\n') };
      }
      const row = {
        scenario: s.name, connections: s.c, durationS: DUR, workerPaused: true, ...ac,
        cpuPctOfOneCore_avgOverWindow: cpuPct,
        apiCpuMsPerRequest: +((cpu1.api - cpu0.api) / 1000 / ac.requests).toFixed(3),
        pgCpuMsPerRequest: +((cpu1.pg - cpu0.pg) / 1000 / ac.requests).toFixed(3),
        redisCpuMsPerRequest: +((cpu1.redis - cpu0.redis) / 1000 / ac.requests).toFixed(3),
        rpsPerApiCore: +(1000 / ((cpu1.api - cpu0.api) / 1000 / ac.requests)).toFixed(1),
        peakDbConnectionsByRole: peak, redisUsedMemoryPeak: peakRedisMem,
        redisCommandsPerRequest: +((Number(r1.total_commands_processed) - Number(r0.total_commands_processed)) / ac.requests).toFixed(2),
        apiMemPeakMiB_cgroup: apiMemPeakMiB, pgss,
      };
      results.push(row);
      console.log(JSON.stringify({ s: s.name, rps: ac.rps, p50: ac.latencyExact?.p50, p95: ac.latencyExact?.p95, p99: ac.latencyExact?.p99, non2xx: ac.non2xx, errors: ac.errors, cpu: cpuPct, apiMs: row.apiCpuMsPerRequest, pgMs: row.pgCpuMsPerRequest, pgss: pgss && { perReq: pgss.statementsPerRequest, dbMs: pgss.dbExecMsPerRequest_toplevel }, apiMem: apiMemPeakMiB }));
    } finally {
      harnessDocker('unpause', 'costaudit-worker');
    }
    await sleep(5000);
  }
  writeJson(`load-${label}.json`, results);
})().catch((e) => { console.error(e); try { harnessDocker('unpause', 'costaudit-worker', { stdio: 'ignore' }); } catch {} process.exit(1); });
