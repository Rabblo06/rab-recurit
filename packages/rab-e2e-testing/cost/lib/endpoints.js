// SQL per request, server/client latency and bytes for the main endpoints, plus the full web-dashboard load.
// Ported from the 2026-10-26 harness. Source of SQL counts: the API's own `request_complete` log (sqlCount =
// statements excluding BEGIN, transactionCount = BEGINs; packages/rab-server/src/engine/observability/request-context.ts),
// cross-checked against pg_stat_statements for /dashboard/summary with the worker paused.
// Differences from the old harness: deterministic choices (no ORDER BY random()); the dashboard set is re-derived from
// rab-front Dashboard.tsx at the commit under test (the pipeline call is CONDITIONAL since dcddb901: only for a next
// shift the caller created with a venue request); psql runs inside the disposable container.
// C1 (2026-10-31): the API page maximum is now 200 (limit > 200 = 400). The three probes that asked for 500/1000 rows ask
// for 200 (the web callers walk pages of 200 instead). Their metric names changed accordingly, so they are not
// comparable with pre-C1 runs of this probe; the screen-traffic measurement does not use this file.
//   node lib/endpoints.js <label>      (env N=10 samples per endpoint)
const crypto = require('crypto');
const { loginWeb, loginMobile, call, requestLog, psql, secrets, median, pct, writeJson, harnessDocker, sleep } = require('./lib');

const label = process.argv[2] || 'run';
const N = Number(process.env.N || 10);
const DAY = 86400_000;
const iso = (ms) => new Date(ms).toISOString();
// Browser-local midnight/week as the dashboard computes them; the harness host runs in UTC terms for determinism.
const startOfDay = (ms) => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
const startOfWeek = (ms) => { const d = new Date(startOfDay(ms)); const dow = (d.getUTCDay() + 6) % 7; return d.getTime() - dow * DAY; };

function signQr(shiftId, venueId, ver, startsAt, endsAt) {
  const secret = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secrets.APP_SECRET, 'utf8'), Buffer.alloc(0), 'rab-qr-token-v1', 32)).toString('hex');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.ceil((new Date(endsAt).getTime() + 120 * 60_000) / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ shiftId, venueId, ver, iat: now, exp, iss: 'rab-attendance', aud: 'rab-qr' });
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

(async () => {
  const started = new Date(Date.now() - 2000).toISOString();
  const mgr = await loginWeb('manager1@org01.example.test');
  const staff = await loginMobile('staff01@org01.example.test');
  const now = Date.now();
  const org = psql(`select id from core.organisation where slug='costaudit-01'`);
  const avatarId = psql(`select avatar_file_id from core."user" where email='staff02@org01.example.test'`);
  const ownAvatarId = psql(`select avatar_file_id from core."user" where email='staff01@org01.example.test'`);
  const me = JSON.parse((await call(mgr, 'GET', '/rest/v1/auth/me')).body);
  const myUserId = me.id || me.user?.id || me.userId;
  const nextList = JSON.parse((await call(mgr, 'GET', `/rest/v1/shifts?from=${iso(startOfDay(now))}&to=${iso(startOfDay(now) + 14 * DAY)}&sort=startsAt&direction=asc&limit=25`)).body).data;
  // Dashboard.tsx Readiness: the next shift being staffed or worked.
  const next = nextList.find((s) => ['open', 'offered', 'partially_filled', 'fully_filled', 'confirmed', 'in_progress'].includes(s.status) && new Date(s.endsAt).getTime() > now);
  const pipelineFired = !!next && !!myUserId && next.createdBy === myUserId && !!next.requestedBy;

  const reads = [
    ['GET /auth/me', mgr, '/rest/v1/auth/me'],
    ['GET /dashboard/summary', mgr, '/rest/v1/dashboard/summary'],
    ['GET /profile', mgr, '/rest/v1/profile'],
    ['GET /offers?status=pending&limit=1', mgr, '/rest/v1/offers?status=pending&limit=1'],
    ['GET /offers?status=staff_accepted&limit=1', mgr, '/rest/v1/offers?status=staff_accepted&limit=1'],
    ['GET /offers?status=manager_confirmed&limit=1', mgr, '/rest/v1/offers?status=manager_confirmed&limit=1'],
    ['GET /offers?status=declined&limit=1', mgr, '/rest/v1/offers?status=declined&limit=1'],
    ['GET /offers?status=expired&limit=1', mgr, '/rest/v1/offers?status=expired&limit=1'],
    ['GET /shifts?30d&status=open&limit=1', mgr, `/rest/v1/shifts?from=${iso(now)}&to=${iso(now + 30 * DAY)}&status=open&limit=1`],
    ['GET /shifts?30d&limit=1', mgr, `/rest/v1/shifts?from=${iso(now)}&to=${iso(now + 30 * DAY)}&limit=1`],
    ['GET /attendance?7d&limit=200', mgr, `/rest/v1/attendance?clockInFrom=${iso(startOfDay(now) - 6 * DAY)}&clockInTo=${iso(now)}&limit=200`],
    ['GET /shifts?-30d&limit=200', mgr, `/rest/v1/shifts?from=${iso(startOfDay(now) - 30 * DAY)}&to=${iso(now)}&limit=200`],
    ['GET /venues', mgr, '/rest/v1/venues'],
    ['GET /shifts?next14d&limit=25', mgr, `/rest/v1/shifts?from=${iso(startOfDay(now))}&to=${iso(startOfDay(now) + 14 * DAY)}&sort=startsAt&direction=asc&limit=25`],
    ['GET /shifts/:id/pipeline', mgr, `/rest/v1/shifts/${next?.id}/pipeline`],
    ['GET /shifts?week&limit=200', mgr, `/rest/v1/shifts?from=${iso(startOfWeek(now))}&to=${iso(startOfWeek(now) + 7 * DAY)}&sort=startsAt&direction=asc&limit=200`],
    ['GET /offers?sort=sentAt&limit=6', mgr, '/rest/v1/offers?sort=sentAt&direction=desc&limit=6'],
    ['GET /shifts (default page)', mgr, '/rest/v1/shifts'],
    ['GET /shifts?limit=50', mgr, '/rest/v1/shifts?limit=50'],
    ['GET /notifications/unread-count (web)', mgr, '/rest/v1/notifications/unread-count'],
    ['GET /notifications/unread-count (mobile)', staff, '/rest/v1/notifications/unread-count'],
    ['GET /offers/mine (mobile)', staff, '/rest/v1/offers/mine'],
    ['GET /files/:id own avatar (mobile)', staff, `/rest/v1/files/${ownAvatarId}`],
    ['GET /files/:id staff avatar (web manager)', mgr, `/rest/v1/files/${avatarId}`],
    ['GET /healthz (no auth)', {}, '/healthz'],
  ];
  // The dashboard's distinct requests (react-query dedupes shared keys): 15 always + the pipeline when pipelineFired.
  const DASH_ALWAYS = reads.slice(1, 17).map((r) => r[0]).filter((n) => n !== 'GET /shifts/:id/pipeline');
  const DASH = pipelineFired ? [...DASH_ALWAYS, 'GET /shifts/:id/pipeline'] : DASH_ALWAYS;
  const DASH_OLD16 = [...DASH_ALWAYS, 'GET /shifts/:id/pipeline']; // the 2026-10-26 audit's set, for comparison only

  const samples = {};
  for (const [name, auth, url] of reads) {
    samples[name] = [];
    for (let i = 0; i < 2; i++) await call(auth, 'GET', url); // warm
    for (let i = 0; i < N; i++) samples[name].push(await call(auth, 'GET', url));
  }

  // Full dashboard load, browser-like: 6 concurrent connections.
  const runDash = async (set) => {
    const runs = [];
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      const queue = reads.filter((r) => set.includes(r[0]));
      const results = [];
      await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) { const [name, auth, url] = queue.shift(); results.push({ name, ...(await call(auth, 'GET', url)) }); } }));
      runs.push({ wallMs: performance.now() - t, results });
    }
    return runs;
  };
  const dashRuns = await runDash(DASH);
  const dashRunsOld16 = await runDash(DASH_OLD16);

  // Write: send offer (manager web) to a staff member with nothing that day, on upcoming shifts with a free slot.
  const pairs = psql(`
    select s.id||','||p.id from core.shift s
      join lateral (select sp.id from core.staff_profile sp where sp.organisation_id=s.organisation_id
          and not exists (select 1 from core.shift_assignment a join core.shift s2 on s2.id=a.shift_id where a.staff_profile_id=sp.id and s2.starts_at::date=s.starts_at::date)
          order by sp.staff_ref limit 1) p on true
     where s.organisation_id='${org}' and s.status in ('open','partially_filled','offered') and s.starts_at > now() + interval '2 days'
     order by s.starts_at, s.id limit ${N}`).split('\n').filter(Boolean).map((l) => l.split(','));
  samples['POST /shifts/:id/offers (web)'] = [];
  for (const [shiftId, staffProfileId] of pairs) samples['POST /shifts/:id/offers (web)'].push(await call(mgr, 'POST', `/rest/v1/shifts/${shiftId}/offers`, { staffProfileId, expiresInHours: 24 }));

  // Write: mark notification read (mobile), repeatable.
  const notifIds = psql(`select n.id from core.notification n join core."user" u on u.id=n.user_id where u.email='staff01@org01.example.test' order by n.created_at desc, n.id limit ${N}`).split('\n');
  samples['POST /notifications/:id/read (mobile)'] = [];
  for (const id of notifIds) samples['POST /notifications/:id/read (mobile)'].push(await call(staff, 'POST', `/rest/v1/notifications/${id}/read`));

  // Write: check-in + clock-in (mobile). A synthetic confirmed shift starting in 5 minutes for a staff member with nothing today.
  const cl = { email: 'staff40@org01.example.test' };
  const row = psql(`
    with sp as (select p.id, p.organisation_id, p.workspace_id, p.job_role_id from core.staff_profile p join core."user" u on u.id=p.user_id where u.email='${cl.email}'),
         v as (select id, lat, lng from core.venue where organisation_id=(select organisation_id from sp) order by name limit 1),
         owner as (select owner_user_id from core.manager_workspace where organisation_id=(select organisation_id from sp)),
         s as (insert into core.shift (organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id, published_at)
               select sp.organisation_id, v.id, sp.job_role_id, now() + interval '5 minutes', now() + interval '20 minutes', 0, 1, 1, 1200, 'fully_filled', owner.owner_user_id, sp.workspace_id, now() from sp, v, owner returning id, venue_id, qr_version, starts_at, ends_at),
         a as (insert into core.shift_assignment (organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, confirmed_at, period, workspace_id)
               select sp.organisation_id, s.id, sp.id, 'confirmed', 1200, now(), tstzrange(s.starts_at, s.ends_at), sp.workspace_id from sp, s returning id)
    select s.id||','||s.venue_id||','||s.qr_version||','||s.starts_at||','||s.ends_at||','||v.lat||','||v.lng from s, v, a`).split(',');
  const [shiftId, venueId, ver, sAt, eAt, lat, lng] = row;
  const clockAuth = await loginMobile(cl.email);
  const loc = () => ({ lat: Number(lat), lng: Number(lng), accuracyM: 8, capturedAt: new Date().toISOString().replace('Z', '+00:00') });
  const qrToken = signQr(shiftId, venueId, Number(ver), sAt, eAt);
  samples['POST /attendance/check-in (mobile)'] = [await call(clockAuth, 'POST', '/rest/v1/attendance/check-in', { shiftId, qrToken, ...loc() })];
  samples['POST /attendance/clock-in (mobile)'] = [await call(clockAuth, 'POST', '/rest/v1/attendance/clock-in', { shiftId, qrToken, ...loc() })];

  // pg_stat_statements cross-check: worker paused so only this traffic is counted; 20x GET /dashboard/summary.
  harnessDocker('pause', 'costaudit-worker');
  let pgss;
  try {
    await sleep(500);
    psql('select pg_stat_statements_reset()');
    for (let i = 0; i < 20; i++) await call(mgr, 'GET', '/rest/v1/dashboard/summary');
    const tl = Number(psql(`select coalesce(sum(calls),0) from pg_stat_statements where userid='crewflow_app'::regrole and toplevel`));
    const all = Number(psql(`select coalesce(sum(calls),0) from pg_stat_statements where userid='crewflow_app'::regrole`));
    const nested = Number(psql(`select coalesce(sum(calls),0) from pg_stat_statements where userid='rab_secure_owner'::regrole`));
    pgss = { endpoint: 'GET /dashboard/summary', requests: 20, crewflowAppToplevelPerRequest: tl / 20, crewflowAppAllPerRequest: all / 20, nestedDefinerPerRequest: nested / 20 };
  } finally {
    harnessDocker('unpause', 'costaudit-worker');
  }

  await sleep(1500);
  const logs = requestLog('costaudit-api', started);
  const summarize = (arr) => {
    const enriched = arr.map((s) => ({ ...s, log: logs.get(s.requestId) || null }));
    const sql = enriched.map((e) => e.log?.sqlCount).filter((x) => x != null);
    const srv = enriched.map((e) => e.log?.durationMs).filter((x) => x != null);
    return {
      n: arr.length, statuses: [...new Set(arr.map((s) => s.status))],
      sqlCountMedian: median(sql), sqlCountMin: sql.length ? Math.min(...sql) : null, sqlCountMax: sql.length ? Math.max(...sql) : null,
      txCountMedian: median(enriched.map((e) => e.log?.transactionCount).filter((x) => x != null)),
      serverMsMedian: median(srv), serverMsP90: pct(srv, 90), clientMsMedian: median(arr.map((s) => s.ms)),
      responseBytesMedian: median(arr.map((s) => s.bytes)), contentEncoding: arr[0]?.contentEncoding || null,
      stagesMedian: (() => { const keys = new Set(enriched.flatMap((e) => Object.keys(e.log?.stages || {}))); return Object.fromEntries([...keys].map((k) => [k, median(enriched.map((e) => e.log?.stages?.[k]).filter((x) => x != null))])); })(),
      errorSample: arr.find((s) => s.status >= 400)?.body.toString().slice(0, 300),
    };
  };
  const out = { label, at: new Date().toISOString(), N, endpoints: {} };
  for (const [k, v] of Object.entries(samples)) out.endpoints[k] = summarize(v);
  const dashSummary = (runs, set) => ({
    requests: set.length, runs: runs.length, concurrency: 6, set,
    wallMsMedian: median(runs.map((r) => r.wallMs)),
    sqlTotalMedian: median(runs.map((r) => r.results.reduce((s, x) => s + (logs.get(x.requestId)?.sqlCount || 0), 0))),
    bytesTotalMedian: median(runs.map((r) => r.results.reduce((s, x) => s + x.bytes, 0))),
    statuses: Object.fromEntries([...new Set(runs.flatMap((r) => r.results.map((x) => `${x.name} ${x.status}`)))].filter((s) => !/ 200$/.test(s)).map((s) => [s, true])),
    sqlTotalSequentialSum: set.reduce((s, k) => s + (out.endpoints[k].sqlCountMedian || 0), 0),
  });
  out.dashboardFullLoad = { ...dashSummary(dashRuns, DASH), pipelineFired, pipelineRule: 'Dashboard.tsx Readiness: pipeline only when next shift createdBy === me && requestedBy (de921c56)' };
  out.dashboardOld16Set = dashSummary(dashRunsOld16, DASH_OLD16);
  out.pgssCrossCheck = { ...pgss, loggedSqlCountMedian: out.endpoints['GET /dashboard/summary'].sqlCountMedian };
  writeJson(`endpoints-${label}.json`, out);
  for (const [k, v] of Object.entries(out.endpoints)) console.log(`${k.padEnd(48)} st=${v.statuses} sql=${v.sqlCountMedian}(${v.sqlCountMin}-${v.sqlCountMax}) tx=${v.txCountMedian} srv=${v.serverMsMedian}ms cli=${v.clientMsMedian?.toFixed?.(1)}ms bytes=${v.responseBytesMedian}${v.errorSample ? ' ERR ' + v.errorSample.slice(0, 120) : ''}`);
  console.log('dashboard', JSON.stringify({ ...out.dashboardFullLoad, set: undefined }));
  console.log('dashboardOld16', JSON.stringify({ ...out.dashboardOld16Set, set: undefined }));
  console.log('pgss', JSON.stringify(out.pgssCrossCheck));
})().catch((e) => { console.error(e); try { harnessDocker('unpause', 'costaudit-worker', { stdio: 'ignore' }); } catch {} process.exit(1); });
