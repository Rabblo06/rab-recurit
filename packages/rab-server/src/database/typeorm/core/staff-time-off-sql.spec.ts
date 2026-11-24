import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  STAFF_TIME_OFF_MAX_DAYS,
  STAFF_TIME_OFF_TEXT_MAX,
  StaffTimeOffStatus,
} from '@rab/shared';

import {
  EXPECTED_STAFF_TIME_OFF_STATE,
  STAFF_TIME_OFF_MAX_DAYS_1786722230000,
  STAFF_TIME_OFF_OWNERSHIP_SQL,
  STAFF_TIME_OFF_PARITY_TRIGGERS,
  STAFF_TIME_OFF_SECURITY_SQL,
  STAFF_TIME_OFF_TABLE_SQL,
  STAFF_TIME_OFF_TEXT_MAX_1786722230000,
  STAFF_TIME_OFF_UPDATABLE_COLUMNS,
  staffTimeOffStateProblems,
} from './staff-time-off-sql';

/**
 * Static shape of StaffTimeOffSchema1786722230000 (DRAFT, owner SQL review; decisions 42, 48). The database behaviour (RLS,
 * grants, the exclusion constraint, the parity guard) is proven in staff-time-off.integration.spec.ts; this pins the text.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const security = STAFF_TIME_OFF_SECURITY_SQL.map(flat);
const policy = (name: string) =>
  security.find((s) => s.startsWith(`CREATE POLICY ${name} `))!;
const TENANT =
  '(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())';
const MANAGER = "(mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)";
const OWN = '(staff_user_id = core.current_uid())';
const NOT_OWN = '(staff_user_id <> core.current_uid())';

describe('core.staff_time_off SQL', () => {
  it('the table: tenant and staff columns NOT NULL, the four states, a valid range of at most 366 days, decision columns consistent', () => {
    const t = flat(STAFF_TIME_OFF_TABLE_SQL);
    for (const col of [
      'organisation_id uuid NOT NULL',
      'workspace_id uuid NOT NULL',
      'staff_profile_id uuid NOT NULL',
      'staff_user_id uuid NOT NULL',
      'starts_on date NOT NULL',
      'ends_on date NOT NULL',
      "status text NOT NULL DEFAULT 'requested'",
      'requested_by uuid NOT NULL',
    ]) {
      expect(t).toContain(col);
    }
    expect(t).toContain(
      `CHECK (status IN (${Object.values(StaffTimeOffStatus)
        .map((s) => `'${s}'`)
        .join(', ')}))`,
    );
    expect(t).toContain(
      'CHECK (ends_on >= starts_on AND ends_on - starts_on < 366)',
    );
    expect(t).toContain('CHECK (note IS NULL OR char_length(note) <= 500)');
    expect(t).toContain(
      'CHECK (decline_reason IS NULL OR char_length(decline_reason) BETWEEN 1 AND 500)',
    );
    expect(t).toContain(
      "WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND decline_reason IS NULL AND cancelled_by IS NULL AND cancelled_at IS NULL",
    );
    expect(t).toContain(
      "WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND decline_reason IS NULL AND ((decided_by IS NULL) = (decided_at IS NULL))",
    );
    expect(t).toContain('ELSE false END');
    expect(t).toContain(
      "EXCLUDE USING gist ( workspace_id WITH =, staff_profile_id WITH =, daterange(starts_on, ends_on, '[]') WITH && ) WHERE (status = 'approved')",
    );
    expect(t).toContain(
      'FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE',
    );
    // Core shape (decision 48): no foreign key into a workspace table.
    expect(t).not.toMatch(/REFERENCES core\.staff_profile\b/);
  });

  it('the CHECK limits are the @rab/shared limits (frozen literals in the migration SQL)', () => {
    expect(STAFF_TIME_OFF_MAX_DAYS_1786722230000).toBe(STAFF_TIME_OFF_MAX_DAYS);
    expect(STAFF_TIME_OFF_TEXT_MAX_1786722230000).toBe(STAFF_TIME_OFF_TEXT_MAX);
  });

  it('ENABLE + FORCE RLS and no PUBLIC access, in the same migration', () => {
    expect(security).toEqual(
      expect.arrayContaining([
        'ALTER TABLE core.staff_time_off ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE core.staff_time_off FORCE ROW LEVEL SECURITY',
        'REVOKE ALL ON TABLE core.staff_time_off FROM PUBLIC',
      ]),
    );
  });

  it('manager policies bind the tenant AND a non-venue, non-archived manager of the workspace, never on their own row', () => {
    for (const [name, cmd] of [
      ['staff_time_off_manager_select', 'SELECT'],
      ['staff_time_off_manager_insert', 'INSERT'],
      ['staff_time_off_manager_update', 'UPDATE'],
    ] as const) {
      const p = policy(name);
      expect(p).toContain(`AS PERMISSIVE FOR ${cmd} TO PUBLIC`);
      expect(p).toContain(TENANT);
      expect(p).toContain(MANAGER);
      expect(p).toContain('(mp.workspace_id = core.current_workspace())');
    }
    expect(policy('staff_time_off_manager_insert')).toContain(NOT_OWN);
    expect(policy('staff_time_off_manager_insert')).toContain(
      "(status = 'approved'::text) AND (requested_by = core.current_uid()) AND (decided_by = core.current_uid())",
    );
    const update = policy('staff_time_off_manager_update');
    expect(update).toMatch(/USING \(.+\) WITH CHECK \(.+\)/);
    expect(update.split('WITH CHECK')[0]).toContain(NOT_OWN);
    expect(update.split('WITH CHECK')[1]).toContain(NOT_OWN);
    expect(update).toContain(
      "(status = ANY (ARRAY['requested'::text, 'approved'::text]))",
    );
    expect(update).toContain(
      "((status = 'cancelled'::text) AND (cancelled_by = core.current_uid()) AND (decided_by IS NOT NULL))",
    );
  });

  it('staff policies bind the tenant AND staff_user_id = the caller; a staff member only requests and cancels a request', () => {
    for (const [name, cmd] of [
      ['staff_time_off_own_select', 'SELECT'],
      ['staff_time_off_own_insert', 'INSERT'],
      ['staff_time_off_own_update', 'UPDATE'],
    ] as const) {
      const p = policy(name);
      expect(p).toContain(`AS PERMISSIVE FOR ${cmd} TO PUBLIC`);
      expect(p).toContain(TENANT);
      expect(p).toContain(OWN);
      expect(p).not.toContain('manager_profile');
    }
    expect(policy('staff_time_off_own_insert')).toContain(
      "(status = 'requested'::text) AND (requested_by = core.current_uid())",
    );
    expect(policy('staff_time_off_own_update')).toBe(
      `CREATE POLICY staff_time_off_own_update ON core.staff_time_off AS PERMISSIVE FOR UPDATE TO PUBLIC USING (${TENANT} AND ${OWN} AND (status = 'requested'::text)) WITH CHECK (${TENANT} AND ${OWN} AND (status = 'cancelled'::text) AND (cancelled_by = core.current_uid()) AND (decided_by IS NULL))`,
    );
    // No Worker or Venue Manager clause, no DELETE policy.
    expect(security.join('\n')).not.toMatch(
      /rab\.actor_type|FOR DELETE|FOR ALL/,
    );
  });

  it('grants: crewflow_app SELECT / INSERT and UPDATE only on the decision and cancellation columns; NO DELETE', () => {
    expect(security).toContain(
      'GRANT SELECT, INSERT ON TABLE core.staff_time_off TO crewflow_app',
    );
    expect(security).toContain(
      'GRANT UPDATE (status, decided_by, decided_at, decline_reason, cancelled_by, cancelled_at, updated_at) ON TABLE core.staff_time_off TO crewflow_app',
    );
    expect(security.join('\n')).not.toMatch(/GRANT[^\n]*DELETE/);
    for (const immutable of [
      'id',
      'organisation_id',
      'workspace_id',
      'staff_profile_id',
      'staff_user_id',
      'starts_on',
      'ends_on',
      'note',
      'requested_by',
      'created_at',
    ]) {
      expect(STAFF_TIME_OFF_UPDATABLE_COLUMNS).not.toContain(immutable);
    }
  });

  it('the owner login is held to the same columns and cannot DELETE or TRUNCATE (the reviewed grant-parity guard, no new function)', () => {
    expect(security).toContain(
      "CREATE TRIGGER _staff_time_off_grant_parity_update BEFORE UPDATE ON core.\"staff_time_off\" FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard('status', 'decided_by', 'decided_at', 'decline_reason', 'cancelled_by', 'cancelled_at', 'updated_at')",
    );
    expect(security).toContain(
      'CREATE TRIGGER _staff_time_off_grant_parity_delete BEFORE DELETE ON core."staff_time_off" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
    );
    expect(security).toContain(
      'CREATE TRIGGER _staff_time_off_grant_parity_truncate BEFORE TRUNCATE ON core."staff_time_off" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
    );
    expect(security.join('\n')).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(STAFF_TIME_OFF_OWNERSHIP_SQL).toEqual([
      'ALTER TABLE core.staff_time_off OWNER TO crewflow',
    ]);
  });

  it('the exported parity trigger list names exactly the triggers created (counted by owner-login-guards)', () => {
    const created = security
      .map((s) => /^CREATE TRIGGER (\S+) /.exec(s)?.[1])
      .filter(Boolean);
    expect([...created].sort()).toEqual(
      [...STAFF_TIME_OFF_PARITY_TRIGGERS].sort(),
    );
  });

  it('the post-condition reports every difference and nothing when the state is as reviewed', () => {
    expect(
      staffTimeOffStateProblems({ ...EXPECTED_STAFF_TIME_OFF_STATE }),
    ).toEqual([]);
    expect(staffTimeOffStateProblems(undefined)).toEqual([
      'core.staff_time_off: missing',
    ]);
    expect(
      staffTimeOffStateProblems({
        ...EXPECTED_STAFF_TIME_OFF_STATE,
        force: false,
        acl: 'crewflow_app:DELETE,crewflow_app:INSERT,crewflow_app:SELECT',
      }),
    ).toHaveLength(2);
  });

  it('the migration hands the table to crewflow only inside withCrewflowCoreCreate and self-checks before commit', () => {
    const source = readFileSync(
      join(__dirname, 'migrations', '1786722230000-StaffTimeOffSchema.ts'),
      'utf8',
    );
    expect(source).toContain('withCrewflowCoreCreate(queryRunner');
    expect(source).toContain('staffTimeOffStateProblems(state)');
    expect(source).toContain('secureOwnerInvariantViolations(');
    expect(source).toMatch(/refusing down\(\): core\.staff_time_off holds/);
  });
});
