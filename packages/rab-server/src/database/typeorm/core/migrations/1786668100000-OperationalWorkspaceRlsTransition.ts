import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 2A step 6 (Revision 3 §1's worked example, applied to the full
 * table list). Every operational table's tenant policy predicate is
 * REPLACED — never a second, additional permissive policy — with a
 * combined `organisation_id = current_org() AND workspace_id =
 * current_workspace()`. This is the actual security-relevant step: a
 * caller now needs a matching legacy org context AND a matching workspace
 * context simultaneously, strictly narrower than either alone, and there
 * is never a moment where two independent PERMISSIVE policies could OR
 * together into a broader effective condition than intended (the exact
 * hazard flagged and designed around before any of this was built).
 *
 * `workspace_id` is still nullable at this point (NOT NULL lands in a
 * later step, once ambiguous-row policy is settled) — a row with
 * `workspace_id IS NULL` is correctly invisible to every ordinary caller
 * under this predicate (NULL = anything is NULL, RLS treats that as
 * "denied"), matching the existing "unresolved rows are admin-only"
 * precedent. The platform-admin path for those rows is a separate,
 * explicit mechanism (Admin Inspect / a future narrow platform query),
 * never a broadened RLS predicate.
 */
export class OperationalWorkspaceRlsTransition1786668100000 implements MigrationInterface {
  name = 'OperationalWorkspaceRlsTransition1786668100000';

  // manager_profile is deliberately NOT in this list — it needs its own
  // split policy (see ManagerProfileWorkspaceRls, the next migration): a
  // new profile is created BY someone else (CEO/Admin/platform) with
  // workspace_id legitimately NULL at INSERT time (an internal Manager's
  // own workspace is only assigned later, at onboarding completion, in a
  // separate UPDATE within the SAME transaction context that resolved
  // current_workspace() as NULL before that workspace existed) — a combined
  // organisation+workspace WITH CHECK would reject both of those, unlike
  // every other table here where the creator's own already-resolved
  // workspace is what's being stamped, with no such chicken-and-egg step.
  private readonly policies = [
    { policy: 'staff_profile_tenant', table: 'staff_profile' },
    { policy: 'venue_tenant', table: 'venue' },
    { policy: 'manager_venue_tenant', table: 'manager_venue' },
    { policy: 'venue_role_rate_tenant', table: 'venue_role_rate' },
    { policy: 'job_role_tenant', table: 'job_role' },
    { policy: 'shift_tenant', table: 'shift' },
    { policy: 'shift_assignment_tenant', table: 'shift_assignment' },
    { policy: 'job_offer_tenant', table: 'job_offer' },
    { policy: 'attendance_tenant', table: 'attendance' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { policy, table } of this.policies) {
      await queryRunner.query(`
        ALTER POLICY ${policy} ON core.${table}
          USING (organisation_id = core.current_org() AND workspace_id = core.current_workspace())
          WITH CHECK (organisation_id = core.current_org() AND workspace_id = core.current_workspace());
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { policy, table } of [...this.policies].reverse()) {
      await queryRunner.query(`
        ALTER POLICY ${policy} ON core.${table}
          USING (organisation_id = core.current_org())
          WITH CHECK (organisation_id = core.current_org());
      `);
    }
  }
}
