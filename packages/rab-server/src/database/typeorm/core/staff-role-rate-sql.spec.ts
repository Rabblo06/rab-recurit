import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXPECTED_STAFF_ROLE_RATE_STATE,
  STAFF_ROLE_RATE_MAX_PENCE,
  STAFF_ROLE_RATE_OWNERSHIP_SQL,
  STAFF_ROLE_RATE_SECURITY_SQL,
  STAFF_ROLE_RATE_TABLE_SQL,
  STAFF_ROLE_RATE_UPDATABLE_COLUMNS,
  staffRoleRateStateProblems,
} from './staff-role-rate-sql';

/**
 * Static shape of StaffRoleRateSchema1786722210000 (DRAFT, owner SQL review). The database behaviour (RLS, grants, the
 * exclusion constraint, the parity guard) is proven in staff-role-rate.integration.spec.ts; this pins the reviewed text.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const security = STAFF_ROLE_RATE_SECURITY_SQL.map(flat);
const policy = (name: string) =>
  security.find((s) => s.startsWith(`CREATE POLICY ${name} `))!;
const TENANT =
  '(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())';
const MANAGER = "(mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)";

describe('core.staff_role_rate SQL', () => {
  it('the table: tenant columns NOT NULL, money bigint pence with a CHECK, a valid period, no overlap per (workspace, staff, role)', () => {
    const t = flat(STAFF_ROLE_RATE_TABLE_SQL);
    for (const col of [
      'organisation_id uuid NOT NULL',
      'workspace_id uuid NOT NULL',
      'staff_profile_id uuid NOT NULL',
      'job_role_id uuid NOT NULL',
      'pay_rate_pence bigint NOT NULL',
      'effective_from date NOT NULL',
      'created_by uuid NOT NULL',
    ]) {
      expect(t).toContain(col);
    }
    expect(t).toContain(
      `CHECK (pay_rate_pence >= 0 AND pay_rate_pence <= ${STAFF_ROLE_RATE_MAX_PENCE})`,
    );
    expect(t).toContain(
      'CHECK (effective_to IS NULL OR effective_to >= effective_from)',
    );
    expect(t).toContain(
      "EXCLUDE USING gist ( workspace_id WITH =, staff_profile_id WITH =, job_role_id WITH =, daterange(effective_from, effective_to, '[]') WITH && )",
    );
    expect(t).toContain(
      'FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id) ON DELETE CASCADE',
    );
    // Core shape: no foreign key into a workspace table (staff_profile / job_role live in the workspace schema with HWS on).
    expect(t).not.toMatch(/REFERENCES core\.(staff_profile|job_role)\b/);
  });

  it('ENABLE + FORCE RLS and no PUBLIC access, in the same migration', () => {
    expect(security).toEqual(
      expect.arrayContaining([
        'ALTER TABLE core.staff_role_rate ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE core.staff_role_rate FORCE ROW LEVEL SECURITY',
        'REVOKE ALL ON TABLE core.staff_role_rate FROM PUBLIC',
      ]),
    );
  });

  it('every policy binds the tenant AND a non-venue, non-archived manager of the workspace; INSERT names its real author', () => {
    for (const [name, cmd] of [
      ['staff_role_rate_select', 'SELECT'],
      ['staff_role_rate_insert', 'INSERT'],
      ['staff_role_rate_update', 'UPDATE'],
      ['staff_role_rate_delete', 'DELETE'],
    ] as const) {
      const p = policy(name);
      expect(p).toContain(`AS PERMISSIVE FOR ${cmd} TO PUBLIC`);
      expect(p).toContain(TENANT);
      expect(p).toContain(MANAGER);
      expect(p).toContain('(mp.workspace_id = core.current_workspace())');
    }
    expect(policy('staff_role_rate_insert')).toContain(
      '(created_by = core.current_uid())',
    );
    expect(policy('staff_role_rate_update')).toMatch(
      /USING \(.+\) WITH CHECK \(.+\)/,
    );
    // No staff-own or worker clause: staff, Venue Managers and the Worker read nothing.
    expect(security.join('\n')).not.toMatch(/rab\.actor_type|sp\.user_id/);
  });

  it('grants: crewflow_app SELECT / INSERT / DELETE and UPDATE only on the amount, the period and updated_at', () => {
    expect(security).toContain(
      'GRANT SELECT, INSERT, DELETE ON TABLE core.staff_role_rate TO crewflow_app',
    );
    expect(security).toContain(
      'GRANT UPDATE (pay_rate_pence, effective_from, effective_to, updated_at) ON TABLE core.staff_role_rate TO crewflow_app',
    );
    for (const immutable of [
      'created_by',
      'staff_profile_id',
      'job_role_id',
      'organisation_id',
      'workspace_id',
      'created_at',
      'id',
    ]) {
      expect(STAFF_ROLE_RATE_UPDATABLE_COLUMNS).not.toContain(immutable);
    }
  });

  it('the owner login is held to the same columns and cannot TRUNCATE (the reviewed grant-parity guard, no new function)', () => {
    expect(security).toContain(
      "CREATE TRIGGER _staff_role_rate_grant_parity_update BEFORE UPDATE ON core.\"staff_role_rate\" FOR EACH ROW EXECUTE FUNCTION core.owner_login_grant_parity_guard('pay_rate_pence', 'effective_from', 'effective_to', 'updated_at')",
    );
    expect(security).toContain(
      'CREATE TRIGGER _staff_role_rate_grant_parity_truncate BEFORE TRUNCATE ON core."staff_role_rate" FOR EACH STATEMENT EXECUTE FUNCTION core.owner_login_grant_parity_guard()',
    );
    expect(security.join('\n')).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(STAFF_ROLE_RATE_OWNERSHIP_SQL).toEqual([
      'ALTER TABLE core.staff_role_rate OWNER TO crewflow',
    ]);
  });

  it('the post-condition reports every difference and nothing when the state is as reviewed', () => {
    expect(
      staffRoleRateStateProblems({ ...EXPECTED_STAFF_ROLE_RATE_STATE }),
    ).toEqual([]);
    expect(staffRoleRateStateProblems(undefined)).toEqual([
      'core.staff_role_rate: missing',
    ]);
    expect(
      staffRoleRateStateProblems({
        ...EXPECTED_STAFF_ROLE_RATE_STATE,
        force: false,
        acl: 'PUBLIC:SELECT',
      }),
    ).toHaveLength(2);
  });

  it('the migration hands the table to crewflow only inside withCrewflowCoreCreate and self-checks before commit', () => {
    const source = readFileSync(
      join(__dirname, 'migrations', '1786722210000-StaffRoleRateSchema.ts'),
      'utf8',
    );
    expect(source).toContain('withCrewflowCoreCreate(queryRunner');
    expect(source).toContain('staffRoleRateStateProblems(state)');
    expect(source).toContain('secureOwnerInvariantViolations(');
    expect(source).toMatch(/refusing down\(\): core\.staff_role_rate holds/);
  });
});
