/**
 * D-Q6 load generator, burst drain and recovery probe. Disposable crewflow-cost stack ONLY: every SQL statement goes
 * through lib.psql (refuses unless the database carries the crewflow-cost disposable marker) and every container
 * stop/start through lib.harnessDocker (refuses anything that is not a harness-owned costaudit-* container).
 *
 *   node lib/dq6-load.js devices
 *   node lib/dq6-load.js steady   <label> [--seconds 330] [--rate 10]
 *   node lib/dq6-load.js burst    <label> [--notifications 2000] [--cap 900]
 *   node lib/dq6-load.js recovery <label> worker|redis [--rate 5] [--pre 60] [--down 30] [--post 60] [--cap 900]
 *
 * One "notification" = what notify() writes for a user with a registered device: a core.notification row plus one row in
 * each outbox: core.realtime_event, core.push_delivery and core.email_outbox (WELCOME, LOGGER driver), inserted in one
 * superuser transaction, round-robin over the costaudit-* organisations (target: each organisation's manager1 and its
 * `dq6-bench` push device, created by `devices`). Rows are tagged with the label, so a scenario measures only its own rows.
 *
 * Measured (all MEASURED; database clock for row timestamps, host clock offset-corrected for the probe's own instants):
 *   latency (created_at -> terminal) p50/p95/p99/max per outbox, throughput, queue depth (non-terminal rows of this label
 *   and BullMQ wait/active list lengths, sampled every 10 s), duplicates (email: LOGGER send lines per row; realtime:
 *   Pub/Sub messages per event, from a PSUBSCRIBE listener; push: provider calls are not observable with the FAKE driver,
 *   attempt_count > 1 is reported), fairness across organisations, errors (terminal FAILED/CANCELLED rows and Worker log
 *   lines), cgroup CPU of PostgreSQL/Worker/Redis and pg_stat_database transactions for the scenario, recovery timings.
 * The generator's own psql transactions are logged in dq6-<label>.gen.jsonl so window statistics can subtract them.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { OUT, psql, redis, harnessDocker, cgroupUsec, dockerEnv, pct, sleep } = require('./lib');

const [mode, label, ...rest] = require.main === module ? process.argv.slice(2) : ['module', process.env.DQ6_LABEL || 'offline'];
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? Number(rest[i + 1]) : dflt;
};
// The label reaches SQL literals and a RegExp, so it is validated in every mode that has one (module mode reads it from
// DQ6_LABEL) and is also regex-escaped where a pattern is built from it.
if (mode !== 'devices' && !/^[a-z0-9_-]{1,60}$/.test(label || '')) throw new Error('label must be [a-z0-9_-]{1,60}');
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const GEN = label ? path.join(OUT, `dq6-${label}.gen.jsonl`) : null;
const logGen = (e) => GEN && fs.appendFileSync(GEN, `${JSON.stringify({ t: Date.now(), ...e })}\n`);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Exact prefix matches (not LIKE: '_' in an arm name would be a wildcard there).
const EMAIL_PREFIX = `dq6-${label}-`;
const RT_PREFIX = `dq6:${label}:`;
const EMAIL_MATCH = `left(recipient_email::text, ${EMAIL_PREFIX.length}) = ${lit(EMAIL_PREFIX)}`;
const RT_MATCH = `left(event_key, ${RT_PREFIX.length}) = ${lit(RT_PREFIX)}`;
const TERMINAL = { email: ['SENT', 'FAILED', 'CANCELLED'], push: ['ACCEPTED', 'FAILED', 'CANCELLED'], realtime: ['completed', 'failed', 'cancelled'] };
const inList = (a) => a.map(lit).join(',');

/** Host clock minus database clock (ms), from the midpoint of a round trip. */
function clockOffset() {
  const a = Date.now();
  const db = Number(psql(`select (extract(epoch from clock_timestamp()) * 1000)::bigint`));
  const b = Date.now();
  logGen({ kind: 'clock', xact: 1 });
  return Math.round((a + b) / 2 - db);
}

function targets() {
  const rows = psql(`
    select o.id, u.id, d.id, w.id
      from core.organisation o
      join core."user" u on u.email = 'manager1@org' || substr(o.slug, 11) || '.example.test'
      join core.push_device d on d.user_id = u.id and d.device_id = 'dq6-bench' and d.active
      join lateral (select id from core.manager_workspace mw where mw.organisation_id = o.id order by created_at limit 1) w on true
     where o.slug like 'costaudit-%'
     order by o.slug`).split('\n').filter(Boolean).map((l) => {
    const [org, uid, dev, ws] = l.split('|');
    return { org, uid, dev, ws };
  });
  logGen({ kind: 'targets', xact: 1, n: rows.length });
  if (rows.length === 0) throw new Error('no targets: run `dq6-load.js devices` after seeding');
  return rows;
}

/** Inserts n notifications (all four rows each) starting at round-robin position seq, in ONE transaction. */
function insertBatch(T, seq, n) {
  const vals = [];
  for (let i = 0; i < n; i++) {
    const t = T[(seq + i) % T.length];
    vals.push(`(${lit(t.org)}::uuid,${lit(t.uid)}::uuid,${lit(t.dev)}::uuid,${lit(t.ws)}::uuid,${lit(crypto.randomUUID())}::uuid)`);
  }
  psql(`begin;
    create temp table p (org uuid, uid uuid, dev uuid, ws uuid, nid uuid) on commit drop;
    insert into p values ${vals.join(',')};
    insert into core.notification (id, organisation_id, user_id, type, title, message) select nid, org, uid, 'dq6', ${lit(label)}, 'dq6' from p;
    insert into core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id)
      select org, ws, uid, 'dq6:' || ${lit(label)} || ':' || nid, 'notification.created', 'notification', nid from p;
    insert into core.push_delivery (organisation_id, notification_id, push_device_id) select org, nid, dev from p;
    insert into core.email_outbox (organisation_id, target_user_id, job_type, recipient_email, rendered_subject, rendered_text)
      select org, uid, 'WELCOME', 'dq6-' || ${lit(label)} || '-' || nid || '@cost.invalid', 'dq6', 'dq6' from p;
    commit;`);
  logGen({ kind: 'insert', xact: 1, n });
  return seq + n;
}

const depthSql = () => `select
  (select count(*) from core.email_outbox where ${EMAIL_MATCH} and status not in (${inList(TERMINAL.email)})),
  (select count(*) from core.push_delivery pd join core.notification n on n.id = pd.notification_id
     where n.type = 'dq6' and n.title = ${lit(label)} and pd.status not in (${inList(TERMINAL.push)})),
  (select count(*) from core.realtime_event where ${RT_MATCH} and status not in (${inList(TERMINAL.realtime)}))`;
const BULL_DEPTH = "local w,a=0,0 for _,k in ipairs(redis.call('KEYS','*:wait')) do w=w+redis.call('LLEN',k) end for _,k in ipairs(redis.call('KEYS','*:active')) do a=a+redis.call('LLEN',k) end return {w,a}";

function sampleDepth() {
  const [email, push, realtime] = psql(depthSql()).split('|').map(Number);
  let bullWait = null;
  let bullActive = null;
  try {
    [bullWait, bullActive] = redis('EVAL', BULL_DEPTH, '0').split('\n').map(Number);
  } catch {
    /* Redis down (recovery scenario) */
  }
  const s = { email, push, realtime, bullWait, bullActive };
  logGen({ kind: 'depth', xact: 1, redisCmds: bullWait == null ? 0 : 1, ...s });
  return s;
}

function pgXact() {
  const v = Number(psql(`select xact_commit + xact_rollback from pg_stat_database where datname = 'rab'`));
  logGen({ kind: 'xact-read', xact: 1 });
  return v;
}
const cpuNow = () => Object.fromEntries(['costaudit-pg', 'costaudit-worker', 'costaudit-redis'].map((c) => {
  try { return [c, cgroupUsec(c)]; } catch { return [c, null]; }
}));

/** PSUBSCRIBE listener for realtime Pub/Sub messages (duplicate detection). */
function startSubscriber(file) {
  const p = spawn('docker', ['exec', 'costaudit-redis', 'redis-cli', '--no-auth-warning', 'PSUBSCRIBE', 'crewflow:*:rt:*'], { env: dockerEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  const ws = fs.createWriteStream(file, { flags: 'a' });
  p.stdout.pipe(ws);
  return { stop: () => { try { p.kill(); } catch { /* gone */ } } };
}

function workerLogsSince(iso) {
  try {
    return execFileSync('docker', ['logs', '--since', iso, 'costaudit-worker'], { env: dockerEnv, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

async function collect(sinceIso, capS, subFile) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < capS * 1000) {
    last = sampleDepth();
    if (last.email === 0 && last.push === 0 && last.realtime === 0) break;
    await sleep(10000);
  }
  const rows = (sql) => psql(sql).split('\n').filter(Boolean).map((l) => l.split('|'));
  const email = rows(`select organisation_id, (extract(epoch from created_at)*1000)::bigint, (extract(epoch from coalesce(sent_at, failed_at, cancelled_at))*1000)::bigint, status, infrastructure_attempt_count, substr(recipient_email::text, ${label.length + 6}, 36)
      from core.email_outbox where ${EMAIL_MATCH}`);
  const push = rows(`select pd.organisation_id, (extract(epoch from pd.created_at)*1000)::bigint, (extract(epoch from coalesce(pd.accepted_at, pd.failed_at, pd.cancelled_at))*1000)::bigint, pd.status, pd.attempt_count, pd.notification_id
      from core.push_delivery pd join core.notification n on n.id = pd.notification_id where n.type = 'dq6' and n.title = ${lit(label)}`);
  const realtime = rows(`select organisation_id, (extract(epoch from created_at)*1000)::bigint,
        (extract(epoch from case when status in (${inList(TERMINAL.realtime)}) then coalesce(processed_at, updated_at) end)*1000)::bigint, status, attempt_count, entity_id
      from core.realtime_event where ${RT_MATCH}`);
  logGen({ kind: 'collect', xact: 3 });
  const logs = workerLogsSince(sinceIso);
  return { last, email, push, realtime, logs, subText: subFile && fs.existsSync(subFile) ? fs.readFileSync(subFile, 'utf8') : null };
}

function stats(a) {
  return { n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: a.length ? Math.max(...a) : null };
}
/** Jain's fairness index over per-organisation mean latency (1 = every organisation waited equally long). */
function fairness(rows) {
  const by = new Map();
  for (const r of rows) if (r.lat != null) (by.get(r.org) || by.set(r.org, []).get(r.org)).push(r.lat);
  const means = [...by.values()].map((v) => v.reduce((s, x) => s + x, 0) / v.length);
  const p95s = [...by.values()].map((v) => pct(v, 95));
  if (!means.length) return null;
  const sum = means.reduce((s, x) => s + x, 0);
  const sq = means.reduce((s, x) => s + x * x, 0);
  return {
    organisations: means.length,
    jainIndexOfMeanLatency: +((sum * sum) / (means.length * sq)).toFixed(4),
    perOrgMeanMs: { min: Math.round(Math.min(...means)), median: pct(means, 50), max: Math.round(Math.max(...means)) },
    perOrgP95Ms: { min: Math.min(...p95s), median: pct(p95s, 50), max: Math.max(...p95s) },
  };
}

function analyse(c, extra) {
  const shape = (rs) => rs.map(([org, created, term, status, attempts, id]) => ({ org, created: Number(created), term: term ? Number(term) : null, status, attempts: Number(attempts), id, lat: term ? Number(term) - Number(created) : null }));
  const kinds = { email: shape(c.email), push: shape(c.push), realtime: shape(c.realtime) };
  // Duplicates. Email: the LOGGER driver prints one "Email not sent (EMAIL_DRIVER=LOGGER) ... to: <recipient>" line per
  // provider call; more than one line for the same row is a duplicate send.
  const sendCount = new Map();
  const re = new RegExp(`to: dq6-${escapeRegExp(label)}-([0-9a-f-]{36})@cost\\.invalid`, 'g');
  for (const m of c.logs.matchAll(re)) sendCount.set(m[1], (sendCount.get(m[1]) || 0) + 1);
  const emailDup = [...sendCount.values()].filter((n) => n > 1).length;
  // Realtime: Pub/Sub messages carrying one of this label's entity ids.
  let rtDup = null;
  let rtSeen = null;
  if (c.subText != null) {
    const ids = new Set(kinds.realtime.map((r) => r.id));
    const seen = new Map();
    for (const m of c.subText.matchAll(/"entityId":"([0-9a-f-]{36})"/g)) if (ids.has(m[1])) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    rtDup = [...seen.values()].filter((n) => n > 1).length;
    rtSeen = seen.size;
  }
  const errLines = c.logs.split('\n').filter((l) => /\b(error|ERROR|Error|FATAL|unhandled)\b/.test(l) && !l.includes('EMAIL_DRIVER=LOGGER'));
  const errSamples = [...new Set(errLines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/(postgres(ql)?|redis):\/\/\S+/g, '<url>').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/^\S+\s+/, '').slice(0, 220)))].slice(0, 8);
  const per = (k) => {
    const rs = kinds[k];
    const status = {};
    for (const r of rs) status[r.status] = (status[r.status] || 0) + 1;
    const created = rs.map((r) => r.created);
    const terms = rs.map((r) => r.term).filter((x) => x != null);
    return {
      rows: rs.length,
      status,
      nonTerminal: rs.filter((r) => r.term == null).length,
      latencyMs: stats(rs.map((r) => r.lat).filter((x) => x != null)),
      attemptsAbove1: rs.filter((r) => r.attempts > 1).length,
      firstCreated: created.length ? Math.min(...created) : null,
      lastTerminal: terms.length ? Math.max(...terms) : null,
      fairness: fairness(rs),
    };
  };
  const out = {
    label,
    note: 'MEASURED on the disposable crewflow-cost stack. Latency = terminal timestamp - created_at (database clock).',
    email: { ...per('email'), duplicateSends: emailDup, rowsWithLoggerSendLine: sendCount.size },
    push: { ...per('push'), duplicates: 'not observable with PUSH_PROVIDER=FAKE (in-memory driver); attemptsAbove1 = retried rows' },
    realtime: { ...per('realtime'), duplicatePublishes: rtDup, distinctEventsSeenOnPubSub: rtSeen },
    workerLogErrorLines: errLines.length,
    workerLogErrorSamples: errSamples,
    depthAtEnd: c.last,
    ...extra,
  };
  out.kinds = undefined;
  return { out, kinds };
}

function write(out) {
  fs.writeFileSync(path.join(OUT, `dq6-${label}.json`), JSON.stringify(out, null, 2));
  const brief = { label, email: out.email.latencyMs, push: out.push.latencyMs, realtime: out.realtime.latencyMs, dupEmail: out.email.duplicateSends, dupRt: out.realtime.duplicatePublishes, nonTerminal: [out.email.nonTerminal, out.push.nonTerminal, out.realtime.nonTerminal], errors: out.workerLogErrorLines };
  console.log(JSON.stringify({ ...brief, ...(out.recovery ? { recovery: out.recovery } : {}), ...(out.throughput ? { throughput: out.throughput } : {}) }));
}

function resources(c0, c1, x0, x1, ms) {
  const cpu = {};
  for (const k of Object.keys(c0)) cpu[k] = c0[k] != null && c1[k] != null && c1[k] >= c0[k] ? +((c1[k] - c0[k]) / 1e6).toFixed(2) : null;
  return { windowS: +(ms / 1000).toFixed(1), cpuSeconds: cpu, pgTransactionsInclHarness: x1 - x0 };
}

async function steady() {
  const seconds = opt('seconds', 330);
  const rate = opt('rate', 10);
  const T = targets();
  const off = clockOffset();
  const sinceIso = new Date(Date.now() - 2000).toISOString();
  const sub = startSubscriber(path.join(OUT, `dq6-${label}.pubsub.txt`));
  const c0 = cpuNow();
  const x0 = pgXact();
  const t0 = Date.now();
  let seq = 0;
  let nextDepth = t0;
  let late = 0;
  for (let tick = 0; Date.now() - t0 < seconds * 1000; tick++) {
    const due = t0 + tick * 1000;
    if (Date.now() > due + 1000) late++;
    seq = insertBatch(T, seq, rate);
    if (Date.now() >= nextDepth) { sampleDepth(); nextDepth += 10000; }
    const wait = t0 + (tick + 1) * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
  }
  const genEnd = Date.now();
  const c = await collect(sinceIso, opt('cap', 600), path.join(OUT, `dq6-${label}.pubsub.txt`));
  sub.stop();
  const c1 = cpuNow();
  const x1 = pgXact();
  const { out } = analyse(c, {
    scenario: 'steady',
    offered: { notificationsPerSecond: rate, seconds, notifications: seq, outboxRows: seq * 3, generatorTicksLate: late },
    clockOffsetHostMinusDbMs: off,
    resources: resources(c0, c1, x0, x1, Date.now() - t0),
  });
  // Time from the generator's last insert until the last row of each outbox became terminal (backlog left by the load).
  out.drainAfterLoadStopMs = Object.fromEntries(['email', 'push', 'realtime'].map((k) => [k, out[k].lastTerminal == null ? null : Math.max(0, out[k].lastTerminal + off - genEnd)]));
  out.throughput = { notificationsPerMinOffered: rate * 60, emailTerminalPerMin: +(out.email.rows - out.email.nonTerminal) / (seconds / 60) };
  write(out);
}

async function burst() {
  const n = opt('notifications', 2000);
  const T = targets();
  const off = clockOffset();
  const sinceIso = new Date(Date.now() - 2000).toISOString();
  const sub = startSubscriber(path.join(OUT, `dq6-${label}.pubsub.txt`));
  const c0 = cpuNow();
  const x0 = pgXact();
  const t0 = Date.now();
  let seq = 0;
  while (seq < n) seq = insertBatch(T, seq, Math.min(500, n - seq));
  const insertedAt = Date.now();
  const c = await collect(sinceIso, opt('cap', 900), path.join(OUT, `dq6-${label}.pubsub.txt`));
  sub.stop();
  const c1 = cpuNow();
  const x1 = pgXact();
  const { out, kinds } = analyse(c, {
    scenario: 'burst',
    offered: { notifications: n, outboxRows: n * 3, organisations: T.length, insertMs: insertedAt - t0 },
    clockOffsetHostMinusDbMs: off,
    resources: resources(c0, c1, x0, x1, Date.now() - t0),
  });
  const drain = {};
  for (const k of ['email', 'push', 'realtime']) {
    const terms = kinds[k].map((r) => r.term).filter((x) => x != null);
    const lastMs = terms.length ? Math.max(...terms) + off - insertedAt : null;
    // Per-organisation completion: the instant the organisation's LAST row of this kind became terminal.
    const lastBy = new Map();
    for (const r of kinds[k]) if (r.term != null) lastBy.set(r.org, Math.max(lastBy.get(r.org) || 0, r.term + off - insertedAt));
    const comp = [...lastBy.values()];
    drain[k] = {
      drainedMsAfterInsert: lastMs,
      rowsPerSecond: lastMs ? +((terms.length / (Math.max(...terms) + off - t0)) * 1000).toFixed(1) : null,
      perOrgCompletionMs: comp.length ? { min: Math.round(Math.min(...comp)), median: pct(comp, 50), max: Math.round(Math.max(...comp)) } : null,
    };
  }
  out.throughput = drain;
  write(out);
}

function waitFor(fn, capMs) {
  const t0 = Date.now();
  return (async () => {
    while (Date.now() - t0 < capMs) {
      try { if (fn()) return Date.now() - t0; } catch { /* not yet */ }
      await sleep(500);
    }
    return null;
  })();
}

async function recovery() {
  const what = rest[0];
  if (what !== 'worker' && what !== 'redis') throw new Error('recovery worker|redis');
  const rate = opt('rate', 5);
  const pre = opt('pre', 60);
  const down = opt('down', 30);
  const post = opt('post', 60);
  const T = targets();
  const off = clockOffset();
  const sinceIso = new Date(Date.now() - 2000).toISOString();
  const subFile = path.join(OUT, `dq6-${label}.pubsub.txt`);
  let sub = startSubscriber(subFile);
  const container = what === 'worker' ? 'costaudit-worker' : 'costaudit-redis';
  const restartsBefore = execFileSync('docker', ['inspect', '-f', '{{.RestartCount}}', 'costaudit-worker'], { env: dockerEnv, encoding: 'utf8' }).trim();
  let seq = 0;
  let running = true;
  const gen = (async () => {
    const t0 = Date.now();
    for (let tick = 0; running; tick++) {
      try { seq = insertBatch(T, seq, rate); } catch (e) { logGen({ kind: 'insert-error', message: String(e.message).slice(0, 200) }); }
      if (tick % 10 === 0) { try { sampleDepth(); } catch { /* ignore */ } }
      const wait = t0 + (tick + 1) * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
    }
  })();
  await sleep(pre * 1000);
  const tStop = Date.now();
  harnessDocker('stop', container);
  const stopMs = Date.now() - tStop;
  if (what === 'redis') sub.stop();
  await sleep(down * 1000);
  const tStart = Date.now();
  harnessDocker('start', container);
  const startIso = new Date(tStart - 1000).toISOString();
  let readyMs = null;
  if (what === 'worker') {
    readyMs = await waitFor(() => /rab-worker ready/.test(workerLogsSince(startIso)), 180000);
  } else {
    readyMs = await waitFor(() => redis('PING') === 'PONG', 60000);
    sub = startSubscriber(subFile);
  }
  await sleep(post * 1000);
  running = false;
  await gen;
  const c = await collect(sinceIso, opt('cap', 900), subFile);
  sub.stop();
  const { out, kinds } = analyse(c, { scenario: `recovery-${what}`, offered: { notificationsPerSecond: rate, pre, down, post, notifications: seq }, clockOffsetHostMinusDbMs: off });
  // Recovery: rows created before the restart instant (they waited through the outage) and when the last of them, per
  // outbox, became terminal; the first terminal row after the restart; rows still not terminal at the cap ("stuck").
  const rec = { what, stopMs, downS: down, readyMsAfterStart: readyMs };
  const startDb = tStart - off;
  for (const k of ['email', 'push', 'realtime']) {
    const before = kinds[k].filter((r) => r.created <= startDb);
    const outage = kinds[k].filter((r) => r.created >= tStop - off && r.created <= startDb);
    const after = kinds[k].map((r) => r.term).filter((x) => x != null && x >= startDb);
    rec[k] = {
      rowsCreatedDuringOutage: outage.length,
      firstTerminalAfterStartMs: after.length ? Math.min(...after) - startDb : null,
      backlogClearedMsAfterStart: before.some((r) => r.term == null) ? null : Math.max(0, Math.max(...before.map((r) => r.term)) - startDb),
      stuckAtCap: kinds[k].filter((r) => r.term == null).length,
      maxLatencyMs: out[k].latencyMs.max,
    };
  }
  rec.workerState = execFileSync('docker', ['inspect', '-f', '{{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}', 'costaudit-worker'], { env: dockerEnv, encoding: 'utf8' }).trim();
  rec.workerRestartCountBefore = Number(restartsBefore);
  rec.workerReadyLinesSinceStart = (workerLogsSince(startIso).match(/rab-worker ready/g) || []).length;
  out.recovery = rec;
  write(out);
}

async function devices() {
  // The token envelope must come from the real SecretEncryptionService (CHECK constraint; the Worker decrypts it). One
  // envelope, made inside the cost API container with that container's key material, is reused for every bench device.
  const js = `
    const f=require('child_process').execSync("find / -path /proc -prune -o -name secret-encryption.service.js -print 2>/dev/null | grep -v node_modules | head -1").toString().trim();
    const {SecretEncryptionService}=require(f);
    const s=new SecretEncryptionService({get:(k)=>process.env[k]});
    process.stdout.write(s.encrypt('dq6-bench-fake-token').toString('hex'));`;
  const hex = execFileSync('docker', ['exec', 'costaudit-api', 'node', '-e', js], { encoding: 'utf8', env: dockerEnv }).trim();
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error('devices: encryption failed');
  const n = psql(`with t as (
      select o.id org, u.id uid from core.organisation o
        join core."user" u on u.email = 'manager1@org' || substr(o.slug, 11) || '.example.test'
       where o.slug like 'costaudit-%')
    insert into core.push_device (organisation_id, user_id, device_id, platform, push_token_encrypted, app_version)
    select org, uid, 'dq6-bench', 'android', decode(${lit(hex)}, 'hex'), 'dq6' from t
    on conflict (user_id, device_id) do nothing returning 1`).split('\n').filter(Boolean).length;
  const total = psql(`select count(*) from core.push_device where device_id = 'dq6-bench' and active`);
  console.log(JSON.stringify({ devicesCreated: n, devicesActive: Number(total) }));
}

// Required as a module (offline check of the analysis on synthetic rows): export the pure parts, run nothing.
if (require.main !== module) module.exports = { analyse, fairness, stats };
else (async () => {
  if (mode === 'devices') return devices();
  if (mode === 'steady') return steady();
  if (mode === 'burst') return burst();
  if (mode === 'recovery') return recovery();
  throw new Error(`unknown mode ${mode}`);
})().then(() => process.exit(0)).catch((e) => { console.error('[dq6-load] FAILED', e.stack || e.message); process.exit(1); });
