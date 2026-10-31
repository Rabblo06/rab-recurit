// Redis bytes per completed BullMQ email job (ported from the 2026-10-26 harness). Triggers N password-reset emails
// through the real API (EMAIL_DRIVER=LOGGER: the worker's real dispatch path, no external send), waits until the
// worker marks them SENT, and diffs Redis used_memory / keys. Also reports email_outbox row sizes by job type.
const { BASE, psql, redis, redisInfo, nextIp, writeJson, sleep } = require('./lib');
const N = Number(process.env.N || 200);

(async () => {
  const emailKeys = () => redis('--scan', '--pattern', '*email*').split('\n').filter(Boolean);
  const mem = () => Number(redisInfo('memory').used_memory);
  const sentResets = () => Number(psql(`select count(*) from core.email_outbox where status='SENT' and job_type ilike '%reset%'`));
  const before = { usedMemory: mem(), dbsize: Number(redis('DBSIZE')), emailKeys: emailKeys().length, sentResets: sentResets() };
  const users = psql(`select email from core."user" where email like 'staff%' order by email limit ${N}`).split('\n');
  const t0 = Date.now();
  let accepted = 0;
  for (const email of users) {
    const r = await fetch(`${BASE}/rest/v1/auth/forgot-password`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() }, body: JSON.stringify({ email, applicationTarget: 'staff_app' }) });
    if (r.status < 300) accepted++;
  }
  let sent = 0;
  for (let i = 0; i < 180; i++) {
    sent = sentResets() - before.sentResets;
    if (sent >= accepted) break;
    await sleep(2000);
  }
  await sleep(3000);
  const after = { usedMemory: mem(), dbsize: Number(redis('DBSIZE')), emailKeys: emailKeys().length };
  const keys = emailKeys();
  const jobHashes = keys.filter((k) => /:email-outbox\.[0-9a-f-]+\.attempt\.\d+$/.test(k)); // bull:rab-email:email-outbox.<id>.attempt.<n>
  const sampleKey = jobHashes[0];
  const keyBytes = sampleKey ? Number(redis('MEMORY', 'USAGE', sampleKey, 'SAMPLES', '0')) : null;
  const streams = keys.filter((k) => k.endsWith(':events')).map((k) => ({ key: k, len: Number(redis('XLEN', k)), bytes: Number(redis('MEMORY', 'USAGE', k, 'SAMPLES', '0')) }));
  const completed = keys.filter((k) => /:rab-email:completed$/.test(k)).map((k) => ({ key: k, card: Number(redis('ZCARD', k)), bytes: Number(redis('MEMORY', 'USAGE', k, 'SAMPLES', '0')) }));
  const rows = psql(`select job_type||'|'||count(*)||'|'||round(avg(coalesce(octet_length(rendered_html),0)))||'|'||round(avg(coalesce(octet_length(rendered_text),0)))||'|'||round(avg(pg_column_size(e.*)))||'|'||count(attachment_file_id) from core.email_outbox e group by job_type order by job_type`).split('\n').filter(Boolean)
    .map((l) => { const [jobType, n, html, text, rowBytes, withAttachment] = l.split('|'); return { jobType, n: +n, avgHtmlBytes: +html, avgTextBytes: +text, avgRowBytesOnDisk_pg_column_size: +rowBytes, withAttachment: +withAttachment }; });
  const jobHashSample = jobHashes.slice(0, 20).map((k) => Number(redis('MEMORY', 'USAGE', k, 'SAMPLES', '0')));
  const out = {
    label_kind: 'MEASURED', requestedResets: users.length, acceptedHttp: accepted, sentResetEmails: sent, secondsToDrain: (Date.now() - t0) / 1000,
    before, after, deltaUsedMemoryBytes: after.usedMemory - before.usedMemory, deltaKeys: after.dbsize - before.dbsize,
    bytesPerCompletedJob_usedMemoryDelta: +((after.usedMemory - before.usedMemory) / Math.max(1, sent)).toFixed(1),
    sampleJobHashKey: sampleKey || null, sampleJobHashMemoryUsageBytes: keyBytes, jobHashKeysPresent: jobHashes.length, jobHashBytesMedianOf20: jobHashSample.sort((a, b) => a - b)[Math.floor(jobHashSample.length / 2)] ?? null, completedSets: completed, eventStreams: streams,
    retention: 'removeOnComplete / removeOnFail as configured in rab-worker email-queue.service.ts (see code at the commit under test)',
    emailOutboxRows: rows,
  };
  writeJson('emails-bullmq.json', out);
  console.log(JSON.stringify({ accepted, sent, deltaBytes: out.deltaUsedMemoryBytes, perJob: out.bytesPerCompletedJob_usedMemoryDelta, keyBytes, completed }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
