// Deterministic synthetic workload for the cost harness: 20 organisations x 50 users = 1,000 users.
// Ported from the 2026-10-26 audit seed (same shape: 1 CEO, 2 managers, 3 venue managers, 44 staff per org; 3-5 venues;
// 20 past days + today + 10 future days x 10 shifts/day; notifications 8/user) with three changes for comparability:
//   1. every id comes from a fixed-seed PRNG (COST_SEED_RANDOM, default 20261027), so two runs build identical rows;
//   2. time is a FIXED logical clock: "now" = COST_SEED_NOW (default 2026-10-27T23:00:00Z: after the day's last shift ends at 22:00, 7 h before the next starts, so no roster falls in the worker's 180-min window during idle measurement), "today" = its UTC midnight.
//      Every timestamp is then translated by one constant delta = (run hour, UTC, floored) - COST_SEED_NOW, so the
//      worker (which reads the real clock) sees exactly the same past/in-progress/future mix on any run date;
//      the delta is printed and recorded. Set COST_SEED_TRANSLATE=0 to keep absolute dates (only sensible on that day);
//   3. no SQL now()/random() in generated data.
// Runs INSIDE a container from the server image under test (pg, argon2 and the compiled role definitions come from /app),
// connected as the disposable cluster's bootstrap superuser (direct inserts, RLS not involved). It refuses to run unless
// the target database carries the crewflow-cost disposable marker.
//   SEED_URL=... SEED_PW=... ORG_FROM=1 ORG_TO=20 node /cost/seed/seed.js
const { Client } = require('pg');
const argon2 = require('argon2');
const { ROLE_DEFS } = require('/app/packages/rab-server/dist/modules/manager/services/manager.service.js');
const { STAFF_ROLE_PERMISSIONS, STAFF_ROLE_KEY } = require('/app/packages/rab-server/dist/modules/staff/services/staff.service.js');

const H = 3600_000;
const DAY = 24 * H;
const PAST_DAYS = 20;
const FUTURE_DAYS = 10;
const SHIFTS_PER_DAY = 10;
const STAFF_PER_ORG = 44;

const LOGICAL_NOW = Date.parse(process.env.COST_SEED_NOW || '2026-10-27T23:00:00Z');
const RUN_HOUR = Math.floor(Date.now() / H) * H;
const DELTA = process.env.COST_SEED_TRANSLATE === '0' ? 0 : RUN_HOUR - LOGICAL_NOW;
const NOW = LOGICAL_NOW + DELTA; // the instant the dataset treats as "now"
const BASE = Math.floor(LOGICAL_NOW / DAY) * DAY + DELTA; // logical "today" 00:00 UTC, translated

// mulberry32 — small, fixed, portable PRNG.
let state = Number(process.env.COST_SEED_RANDOM || 20261027) >>> 0;
function rand() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function uuid() {
  const b = Array.from({ length: 16 }, () => Math.floor(rand() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
const at = (ms) => new Date(ms);

async function main() {
  const from = Number(process.env.ORG_FROM || 1);
  const to = Number(process.env.ORG_TO || 20);
  const c = new Client({ connectionString: process.env.SEED_URL });
  await c.connect();
  const marker = (await c.query(`SELECT shobj_description(oid, 'pg_database') AS d FROM pg_database WHERE datname = current_database()`)).rows[0]?.d;
  if (marker !== 'crewflow-cost disposable measurement database') throw new Error('refusing: target database is not the crewflow-cost disposable cluster');
  const existing = Number((await c.query(`SELECT count(*) FROM core.organisation WHERE slug LIKE 'costaudit-%'`)).rows[0].count);
  if (existing > 0 && from === 1) throw new Error(`refusing: ${existing} costaudit organisations already exist (re-create the stack)`);
  // PRNG stream is advanced per org in a fixed way so ORG_FROM>1 still yields the same rows as a full run.
  const hash = await argon2.hash(process.env.SEED_PW, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const perms = new Map((await c.query('SELECT id, key FROM core.permission')).rows.map((r) => [r.key, r.id]));
  console.log(JSON.stringify({ logicalNow: new Date(LOGICAL_NOW).toISOString(), effectiveNow: at(NOW).toISOString(), translationHours: DELTA / H, prngSeed: Number(process.env.COST_SEED_RANDOM || 20261027) }));
  const summary = [];

  for (let o = from; o <= to; o++) {
    state = (Number(process.env.COST_SEED_RANDOM || 20261027) + o * 7919) >>> 0; // per-org stream
    const t0 = Date.now();
    await c.query('BEGIN');
    const q = async (sql, params) => (await c.query(sql, params)).rows;
    const one = async (sql, params) => (await q(sql, params))[0];
    const slug = `costaudit-${pad(o)}`;
    const org = uuid();
    await q(`INSERT INTO core.organisation (id, name, slug, timezone, created_at) VALUES ($1, $2, $3, 'Europe/London', $4)`, [org, `CostAudit Org ${pad(o)} (synthetic)`, slug, at(BASE - 60 * DAY)]);

    const roleIds = {};
    const mkRole = async (key, name, keys) => {
      const id = uuid();
      await q(`INSERT INTO core.role (id, organisation_id, key, name, is_system) VALUES ($1, $2, $3, $4, true)`, [id, org, key, name]);
      for (const k of [...keys].sort()) if (perms.has(k)) await q(`INSERT INTO core.role_permission (role_id, permission_id, organisation_id) VALUES ($1, $2, $3)`, [id, perms.get(k), org]);
      roleIds[key] = id;
    };
    await mkRole('ceo', 'CEO', ROLE_DEFS.ceo.permissions);
    await mkRole('manager', 'Manager', ROLE_DEFS.internal.permissions);
    await mkRole('venue_manager', 'Venue Manager', ROLE_DEFS.venue.permissions);
    await mkRole(STAFF_ROLE_KEY, 'Staff', STAFF_ROLE_PERMISSIONS);

    const mkUser = async (email, first, last, roleKey) => {
      const id = uuid();
      await q(
        `INSERT INTO core."user" (id, organisation_id, email, password_hash, first_name, last_name, status, email_verified_at) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
        [id, org, email, hash, first, last, at(BASE - 30 * DAY)],
      );
      await q(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [id, roleIds[roleKey], org]);
      await q(`INSERT INTO core.organisation_member (organisation_id, user_id) VALUES ($1, $2)`, [org, id]);
      return id;
    };
    const dom = `org${pad(o)}.example.test`;
    const ceo = await mkUser(`ceo@${dom}`, 'Casey', `Owner${pad(o)}`, 'ceo');
    const managers = [];
    for (let i = 1; i <= 2; i++) managers.push(await mkUser(`manager${i}@${dom}`, 'Morgan', `Manager${pad(o)}${i}`, 'manager'));
    const owner = managers[0];
    // Workspace owned by the Initial Manager, provisioned through the same SECURITY DEFINER function the API calls.
    const ws = uuid();
    await q(
      `INSERT INTO core.manager_workspace (id, organisation_id, owner_user_id, name, subdomain, status, onboarding_completed_at, schema_status) VALUES ($1, $2, $3, $4, $5, 'active', $6, 'CREATING')`,
      [ws, org, owner, `CostAudit Workspace ${pad(o)}`, slug, at(BASE - 30 * DAY)],
    );
    await q(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true), set_config('rab.workspace_id', $3, true)`, [org, owner, ws]);
    const prov = (await one(`SELECT core.provision_workspace($1) AS outcome`, [ws])).outcome;
    const member = (uid) => q(`INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source) VALUES ($1, $2, $3, 'active', 'write_path')`, [org, uid, ws]);
    await q(`INSERT INTO core.manager_profile (id, organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, 'ceo', $4)`, [uuid(), org, ceo, ws]);
    await member(ceo);
    for (const [i, u] of managers.entries()) {
      await q(`INSERT INTO core.manager_profile (id, organisation_id, user_id, type, workspace_id, is_initial_manager) VALUES ($1, $2, $3, 'internal', $4, $5)`, [uuid(), org, u, ws, i === 0]);
      await member(u);
    }

    const jobRoles = [];
    for (const [name, rate] of [['Bartender', 1250], ['Waiter', 1150], ['Chef', 1500], ['Porter', 1100]]) {
      const id = uuid();
      await q(`INSERT INTO core.job_role (id, organisation_id, workspace_id, name, default_rate_pence, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [id, org, ws, name, rate, owner]);
      jobRoles.push({ id, rate });
    }
    const venueCount = 3 + (o % 3);
    const venues = [];
    for (let v = 0; v < venueCount; v++) {
      const id = uuid();
      await q(
        `INSERT INTO core.venue (id, organisation_id, workspace_id, name, type, address, lat, lng, geofence_radius_m, enforce_geofence, status, created_by)
         VALUES ($1, $2, $3, $4, 'hotel', $5, $6, $7, 200, false, 'active', $8)`,
        [id, org, ws, `Venue ${pad(o)}-${v + 1}`, JSON.stringify({ line1: `${v + 1} Example Street`, city: 'London', postcode: 'E1 1AA' }), 51.5 + v * 0.01, -0.12 + o * 0.001, owner],
      );
      venues.push(id);
    }
    const vms = [];
    for (let i = 1; i <= 3; i++) {
      const u = await mkUser(`venuemanager${i}@${dom}`, 'Vic', `VenueMgr${pad(o)}${i}`, 'venue_manager');
      const mp = uuid();
      await q(`INSERT INTO core.manager_profile (id, organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, 'venue', $4)`, [mp, org, u, ws]);
      await q(`INSERT INTO core.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`, [org, mp, venues[(i - 1) % venues.length], ws]);
      await member(u);
      vms.push(u);
    }
    const staff = [];
    for (let i = 1; i <= STAFF_PER_ORG; i++) {
      const u = await mkUser(`staff${pad(i)}@${dom}`, 'Sam', `Staff${pad(o)}${pad(i)}`, STAFF_ROLE_KEY);
      await member(u);
      const jr = jobRoles[i % jobRoles.length];
      const sp = uuid();
      await q(
        `INSERT INTO core.staff_profile (id, organisation_id, user_id, staff_ref, created_by, workspace_id, employment_status, job_role_id, default_pay_rate_pence)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
        [sp, org, u, `CA${pad(o)}-${pad(i, 3)}`, owner, ws, jr.id, jr.rate],
      );
      staff.push({ user: u, sp });
    }

    // Shifts: PAST_DAYS completed days, today, FUTURE_DAYS upcoming; SHIFTS_PER_DAY per day, 3-5 staff each.
    let nShift = 0, nAssign = 0, nOffer = 0, nAtt = 0;
    const offerSql = `INSERT INTO core.job_offer (id, organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, responded_at, estimated_pay_pence, created_by, workspace_id, staff_accepted_at, manager_confirmed_at, confirmed_by, decline_reason)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;
    for (let d = -PAST_DAYS; d <= FUTURE_DAYS; d++) {
      let cursor = ((d + PAST_DAYS) * 7) % STAFF_PER_ORG;
      for (let j = 0; j < SHIFTS_PER_DAY; j++) {
        const required = 3 + (j % 3);
        const jr = jobRoles[j % jobRoles.length];
        const start = BASE + d * DAY + (6 + (j % 5) * 2) * H;
        const end = start + 8 * H;
        const past = end < NOW;
        // Future plan per slot: confirmed / offered / staff_accepted / declined / unfilled.
        const plan = [];
        for (let k = 0; k < required; k++) {
          if (past) plan.push('completed');
          else {
            const r = (j * 7 + k * 3 + d + 1000) % 10;
            plan.push(r < 4 ? 'confirmed' : r < 6 ? 'offered' : r < 7 ? 'staff_accepted' : r < 8 ? 'declined' : 'none');
          }
        }
        const filled = plan.filter((p) => p === 'confirmed' || p === 'completed').length;
        const draft = !past && d >= 8 && j >= 8;
        const status = past ? 'completed' : draft ? 'draft' : filled >= required ? 'fully_filled' : filled > 0 ? 'partially_filled' : plan.some((p) => p === 'offered') ? 'offered' : 'open';
        const shift = uuid();
        await q(
          `INSERT INTO core.shift (id, organisation_id, venue_id, job_role_id, starts_at, ends_at, break_minutes, required_count, filled_count, pay_rate_pence, status, created_by, workspace_id, published_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,30,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [shift, org, venues[j % venues.length], jr.id, at(start), at(end), required, draft ? 0 : filled, jr.rate, status, owner, ws, draft ? null : at(start - 7 * DAY), at(start - 8 * DAY)],
        );
        nShift++;
        if (draft) continue;
        for (const p of plan) {
          const s = staff[cursor % STAFF_PER_ORG];
          cursor++;
          if (p === 'none') continue;
          const sent = Math.min(start - 5 * DAY, NOW - 2 * H);
          const asStatus = p === 'completed' ? 'completed' : p;
          const a = uuid();
          await q(
            `INSERT INTO core.shift_assignment (id, organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, confirmed_at, period, workspace_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $5 IN ('confirmed','completed') THEN $8::timestamptz END, tstzrange($9,$10), $11)`,
            [a, org, shift, s.sp, asStatus, jr.rate, managers[j % 2], at(sent + H), at(start), at(end), ws],
          );
          nAssign++;
          const est = jr.rate * 8;
          const offerStatus = { completed: 'manager_confirmed', confirmed: 'manager_confirmed', offered: 'pending', staff_accepted: 'staff_accepted', declined: 'declined' }[p];
          const responded = offerStatus === 'pending' ? null : at(sent + 30 * 60_000);
          await q(offerSql, [uuid(), org, a, s.sp, offerStatus, at(sent), at(Math.max(start - H, NOW + DAY)), responded, est, managers[j % 2], ws,
            ['manager_confirmed', 'staff_accepted'].includes(offerStatus) ? responded : null,
            offerStatus === 'manager_confirmed' ? at(sent + H) : null,
            offerStatus === 'manager_confirmed' ? managers[j % 2] : null,
            offerStatus === 'declined' ? 'unavailable' : null]);
          nOffer++;
          if (p === 'completed') {
            const late = (nAtt % 9 === 0) ? 12 : 0;
            const worked = 8 * 60 - 30 - late;
            const attStatus = d < -3 ? 'approved' : 'clocked_out';
            await q(
              `INSERT INTO core.attendance (id, organisation_id, shift_assignment_id, shift_id, staff_profile_id, workspace_id, clock_in_at, clock_out_at, status, worked_minutes, earned_pence, clock_in_method, clock_out_method, break_minutes, location_verified)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'staff','manual',30,true)`,
              [uuid(), org, a, shift, s.sp, ws, at(start + late * 60_000), at(end), attStatus, worked, Math.round((jr.rate * worked) / 60)],
            );
            nAtt++;
          }
        }
      }
    }
    // Extra expired / withdrawn offers on upcoming shifts (history noise, as a busy roster accumulates).
    const extra = await q(
      `SELECT s.id AS shift_id, s.starts_at, s.ends_at, s.pay_rate_pence, sp.id AS staff_profile_id
         FROM core.shift s CROSS JOIN LATERAL (
           SELECT p.id FROM core.staff_profile p WHERE p.organisation_id = s.organisation_id
              AND NOT EXISTS (SELECT 1 FROM core.shift_assignment x WHERE x.shift_id = s.id AND x.staff_profile_id = p.id)
            ORDER BY p.staff_ref DESC LIMIT 1) sp
        WHERE s.organisation_id = $1 AND s.status IN ('open','partially_filled','offered') ORDER BY s.starts_at, s.id LIMIT 30`, [org]);
    for (const [i, r] of extra.entries()) {
      const a = uuid();
      await q(
        `INSERT INTO core.shift_assignment (id, organisation_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7, tstzrange($8,$9), $10)`,
        [a, org, r.shift_id, r.staff_profile_id, i % 2 ? 'cancelled' : 'withdrawn', r.pay_rate_pence, managers[0], r.starts_at, r.ends_at, ws]);
      nAssign++;
      await q(offerSql, [uuid(), org, a, r.staff_profile_id, i % 2 ? 'expired' : 'withdrawn', at(NOW - 3 * DAY), at(NOW - 2 * DAY), null, 10000, managers[0], ws, null, null, null, null]);
      nOffer++;
    }
    // Notifications: 8 per user, 3 unread.
    const everyone = [ceo, ...managers, ...vms, ...staff.map((s) => s.user)];
    let nNotif = 0;
    for (const u of everyone) {
      for (let k = 0; k < 8; k++) {
        await q(
          `INSERT INTO core.notification (id, organisation_id, user_id, type, title, message, read_at, created_at) VALUES ($1,$2,$3,'offer_received','New shift offer','You have a new shift offer (synthetic).', $4, $5)`,
          [uuid(), org, u, k < 3 ? null : at(NOW - k * H), at(NOW - k * 7 * H)],
        );
        nNotif++;
      }
    }
    await q('COMMIT');
    summary.push({ org: slug, organisationId: org, workspaceId: ws, provision: prov, venues: venueCount, shifts: nShift, assignments: nAssign, offers: nOffer, attendance: nAtt, notifications: nNotif, ms: Date.now() - t0 });
    console.log(JSON.stringify(summary[summary.length - 1]));
  }
  await c.end();
}

main().catch((e) => {
  console.error('SEED FAILED', e.message, e.detail || '', e.where || '');
  process.exit(1);
});
