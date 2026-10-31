// Shift-cycle window: MEASURES the roster stage of one shift through the real worker code path.
// The logical clock puts every seeded shift outside the worker's 180-minute roster window (so idle windows are pure
// polling). This step brings K upcoming shifts (one per organisation) INTO the window with a single superuser UPDATE
// (start = now + 90 min, 4 h long, assignments moved with them) — a synthetic trigger, stated as such — then lets the
// unmodified worker do what it does in production: render the roster PDF (real Chromium), store it in S3, enqueue and
// dispatch the venue managers' emails with the PDF attached. Run LAST: it changes 20 shifts.
//   node lib/shift-cycle.js prepare <K>      -> prints the chosen shift ids (JSON) to $COST_OUT/shift-cycle.prepare.json
//   node lib/shift-cycle.js collect          -> waits for completion, writes $COST_OUT/shift-cycle.json
const fs = require('fs');
const path = require('path');
const { OUT, psql, cgroupUsec, writeJson, sleep } = require('./lib');

const mode = process.argv[2];
(async () => {
  if (mode === 'prepare') {
    const K = Number(process.argv[3] || 20);
    const ids = psql(`
      select string_agg(id::text, ',') from (
        select distinct on (s.organisation_id) s.id from core.shift s
         where s.starts_at > now() and s.status in ('fully_filled','partially_filled','offered','open')
           and exists (select 1 from core.shift_assignment a where a.shift_id = s.id and a.status = 'confirmed')
           and exists (select 1 from core.manager_venue mv where mv.venue_id = s.venue_id)
         order by s.organisation_id, s.starts_at, s.id) x`).split(',').filter(Boolean).slice(0, K);
    const list = `'${ids.join("','")}'`;
    psql(`begin;
      update core.shift set starts_at = now() + interval '90 minutes', ends_at = now() + interval '330 minutes', updated_at = now() where id in (${list});
      update core.shift_assignment a set period = tstzrange(s.starts_at, s.ends_at) from core.shift s where s.id = a.shift_id and s.id in (${list});
      update core.job_offer o set expires_at = least(o.expires_at, now() + interval '60 minutes') from core.shift_assignment a where a.id = o.shift_assignment_id and a.shift_id in (${list}) and o.status = 'pending';
      commit;`);
    const facts = psql(`select count(*)||'|'||sum((select count(*) from core.shift_assignment a where a.shift_id=s.id and a.status='confirmed'))||'|'||sum((select count(distinct mp.user_id) from core.manager_venue mv join core.manager_profile mp on mp.id=mv.manager_profile_id where mv.venue_id=s.venue_id)) from core.shift s where s.id in (${list})`).split('|').map(Number);
    const snap = {
      at: new Date().toISOString(), shiftIds: ids, shifts: facts[0], confirmedStaff: facts[1], venueManagerRecipients: facts[2],
      emailOutboxBefore: Number(psql('select count(*) from core.email_outbox')), storedFilesBefore: Number(psql('select count(*) from core.stored_file')),
      workerCpuUsecBefore: cgroupUsec('costaudit-worker'), pgCpuUsecBefore: cgroupUsec('costaudit-pg'), t0: Date.now(),
    };
    psql('select pg_stat_statements_reset()');
    writeJson('shift-cycle.prepare.json', snap);
    console.log(JSON.stringify({ shifts: snap.shifts, confirmedStaff: snap.confirmedStaff, venueManagerRecipients: snap.venueManagerRecipients }));
    return;
  }
  if (mode === 'collect') {
    const snap = JSON.parse(fs.readFileSync(path.join(OUT, 'shift-cycle.prepare.json'), 'utf8'));
    const list = `'${snap.shiftIds.join("','")}'`;
    let rendered = 0;
    const deadline = Date.now() + 15 * 60_000; // the roster scheduler runs every 5 min (interval mode)
    while (Date.now() < deadline) {
      rendered = Number(psql(`select count(*) from core.shift_report where shift_id in (${list}) and pre_shift_pdf_generated_at is not null`));
      if (rendered >= snap.shifts) break;
      await sleep(10_000);
    }
    const expectedEmails = snap.venueManagerRecipients;
    let sent = 0;
    for (let i = 0; i < 36; i++) {
      sent = Number(psql(`select count(*) from core.email_outbox where created_at >= '${snap.at}' and status = 'SENT' and attachment_file_id is not null`));
      if (sent >= expectedEmails) break;
      await sleep(5000);
    }
    await sleep(5000);
    const t1 = Date.now();
    const workerCpuS = (cgroupUsec('costaudit-worker') - snap.workerCpuUsecBefore) / 1e6;
    const pgCpuS = (cgroupUsec('costaudit-pg') - snap.pgCpuUsecBefore) / 1e6;
    const emails = psql(`select status||'|'||count(*)||'|'||count(attachment_file_id) from core.email_outbox where created_at >= '${snap.at}' group by status order by status`).split('\n').filter(Boolean).map((l) => { const [status, n, withAttachment] = l.split('|'); return { status, n: +n, withAttachment: +withAttachment }; });
    const files = psql(`select kind||'|'||count(*)||'|'||round(avg(size_bytes)) from core.stored_file where created_at >= '${snap.at}' group by kind order by kind`).split('\n').filter(Boolean).map((l) => { const [kind, n, avgBytes] = l.split('|'); return { kind, n: +n, avgBytes: +avgBytes }; });
    const renders = Number(psql(`select count(*) from core.stored_file where created_at >= '${snap.at}' and kind = 'SHIFT_ROSTER_PDF'`));
    const sql = psql(`select coalesce(sum(calls),0)||'|'||coalesce(sum(calls) filter (where toplevel),0) from pg_stat_statements where userid in ('crewflow_app'::regrole,'crewflow'::regrole)`).split('|').map(Number);
    // Per-fingerprint dump of the whole window (every role, nested or not; pg_stat_statements was reset at `prepare`), for
    // attributing statements per roster email (enqueue in the scheduler, revalidation in the send processor). Compared
    // across runs by normalised query text, because queryid depends on relation OIDs.
    fs.writeFileSync(path.join(OUT, 'shift-cycle.pgss-raw.csv'), psql(`copy (select userid::regrole::text as role, toplevel, calls, rows, round(total_exec_time::numeric,3) as total_exec_ms, queryid, query from pg_stat_statements where dbid=(select oid from pg_database where datname='rab') order by calls desc) to stdout with csv header`) + '\n');
    const emailRows = emails.reduce((s, e) => s + e.n, 0);
    const out = {
      label_kind: 'MEASURED (synthetic trigger: K shifts moved into the roster window by one superuser UPDATE)',
      shifts: snap.shifts, confirmedStaff: snap.confirmedStaff, venueManagerRecipients: snap.venueManagerRecipients,
      windowSeconds: +((t1 - snap.t0) / 1000).toFixed(1), rostersRenderedForChosenShifts: rendered, rosterPdfRowsCreated: renders,
      emailsCreated: emails, storedFilesCreated: files,
      perShift: {
        rosterPdfs: +(renders / snap.shifts).toFixed(3),
        rosterEmails: +(emailRows / snap.shifts).toFixed(3),
        rosterEmailsWithPdfAttachment: +(emails.reduce((s, e) => s + e.withAttachment, 0) / snap.shifts).toFixed(3),
      },
      workerCpuSecondsInWindow: +workerCpuS.toFixed(2), pgCpuSecondsInWindow: +pgCpuS.toFixed(2),
      runtimeStatementsInWindow: sql[0], runtimeToplevelStatementsInWindow: sql[1],
      note: 'Window CPU/SQL include the idle worker loops running during the same window; subtract the idle-O20 rate (see results.json) for the incremental cost.',
    };
    writeJson('shift-cycle.json', out);
    console.log(JSON.stringify({ perShift: out.perShift, rendered, renders, emails, workerCpuS: out.workerCpuSecondsInWindow, window: out.windowSeconds }, null, 1));
    return;
  }
  throw new Error('usage: shift-cycle.js prepare <K> | collect');
})().catch((e) => { console.error(e); process.exit(1); });
