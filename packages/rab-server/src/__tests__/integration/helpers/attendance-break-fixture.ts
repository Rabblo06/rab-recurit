import { Client } from 'pg';

import { SeededWorkspace } from './workspace-fixtures';

/**
 * Test-only fixture for the breaks / sync receipts specs (M4 §13 PR 2), in `core` or a workspace schema of `w`. Seeded as the
 * superuser. One workspace, two venues: shift X (venue X) with Staff A (open attendance, clocked in) and Staff B (open
 * attendance); shift Y (venue Y) with Staff B (clocked out). A Manager of the workspace, a Venue Manager per venue, a stranger
 * and a manager of a sibling workspace (same organisation).
 */
export type BreakFixtureUser = 'staffA' | 'staffB' | 'manager' | 'vmX' | 'vmY' | 'stranger' | 'otherManager';

export interface BreakFixture {
  schema: string;
  users: Record<BreakFixtureUser, string>;
  profiles: { a: string; b: string };
  shifts: { x: string; y: string };
  /** xA, xB: open (clocked_in); yB: clocked_out. */
  att: { xA: string; xB: string; yB: string };
  sibling: string;
}

export async function seedBreakFixture(admin: Client, w: SeededWorkspace, schema: string, tag: string): Promise<BreakFixture> {
  if (schema !== 'core' && schema !== w.schema) throw new Error('fixture schema must be core or the workspace schema');
  const q = `"${schema}"`;
  const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0].id as string;
  const users = { staffA: '', staffB: '', manager: '', vmX: '', vmY: '', stranger: '', otherManager: '' } as Record<BreakFixtureUser, string>;
  for (const k of Object.keys(users) as BreakFixtureUser[]) {
    users[k] = await one(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Brk', $3, 'active') RETURNING id`, [
      w.org,
      `brk-${tag}-${k}@brk.invalid`,
      k,
    ]);
  }
  const profile = (user: string, label: string) =>
    one(`INSERT INTO ${q}.staff_profile (organisation_id, workspace_id, user_id, staff_ref, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
      w.org,
      w.id,
      user,
      `BRK-${tag}-${label}`,
      w.owner,
    ]);
  const profiles = { a: await profile(users.staffA, 'a'), b: await profile(users.staffB, 'b') };
  const manager = (user: string, type: string, workspaceId: string) =>
    one(`INSERT INTO core.manager_profile (organisation_id, user_id, type, workspace_id) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, user, type, workspaceId]);
  await manager(users.manager, 'internal', w.id);
  const sibling = await one(
    `INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status, schema_status) VALUES ($1, $2, $3, $3, 'active', 'CREATING') RETURNING id`,
    [w.org, users.otherManager, `brk-sibling-${tag}`],
  );
  await manager(users.otherManager, 'internal', sibling);
  const vmX = await manager(users.vmX, 'venue', w.id);
  const vmY = await manager(users.vmY, 'venue', w.id);
  const venue = (name: string) => one(`INSERT INTO ${q}.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [w.org, w.id, name, w.owner]);
  const [venueX, venueY] = [await venue(`BRK X ${tag}`), await venue(`BRK Y ${tag}`)];
  for (const [vm, v] of [[vmX, venueX], [vmY, venueY]]) {
    await admin.query(`INSERT INTO ${q}.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`, [w.org, vm, v, w.id]);
  }
  const role = await one(`INSERT INTO ${q}.job_role (organisation_id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [w.org, w.id, `BRK role ${tag}`]);
  const shift = (v: string) =>
    one(
      `INSERT INTO ${q}.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, status, created_by)
       VALUES ($1, $2, $3, $4, now() - interval '2 hours', now() + interval '6 hours', 3, 1200, 'in_progress', $5) RETURNING id`,
      [w.org, w.id, v, role, w.owner],
    );
  const shifts = { x: await shift(venueX), y: await shift(venueY) };
  const seat = (s: string, p: string) =>
    one(
      `INSERT INTO ${q}.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period)
       VALUES ($1, $2, $3, $4, 'confirmed', 1200, $5, tstzrange(now() - interval '2 hours', now() + interval '6 hours', '[)')) RETURNING id`,
      [w.org, w.id, s, p, w.owner],
    );
  const attend = async (s: string, p: string) =>
    one(
      `INSERT INTO ${q}.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, status)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', 'clocked_in') RETURNING id`,
      [w.org, w.id, await seat(s, p), s, p],
    );
  const att = { xA: await attend(shifts.x, profiles.a), xB: await attend(shifts.x, profiles.b), yB: '' };
  // Staff B's earlier, finished shift at venue Y (a non-overlapping seat: shift_assignment_no_double_booking).
  att.yB = await one(
    `WITH seat AS (
       INSERT INTO ${q}.shift_assignment (organisation_id, workspace_id, shift_id, staff_profile_id, status, pay_rate_snapshot_pence, assigned_by, period)
       VALUES ($1, $2, $3, $4, 'completed', 1200, $5, tstzrange(now() - interval '30 hours', now() - interval '26 hours', '[)')) RETURNING id)
     INSERT INTO ${q}.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status)
     SELECT $1, $2, seat.id, $3, $4, now() - interval '30 hours', now() - interval '26 hours', 'clocked_out' FROM seat RETURNING id`,
    [w.org, w.id, shifts.y, profiles.b, w.owner],
  );
  return { schema, users, profiles, shifts, att, sibling };
}

/** A valid 64-hex request hash for receipts. */
export const SHA = 'a'.repeat(64);
