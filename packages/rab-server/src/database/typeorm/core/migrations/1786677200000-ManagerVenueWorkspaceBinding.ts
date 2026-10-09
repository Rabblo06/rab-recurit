import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Legacy core manager-link hardening, before runtime cutover.
 *
 * 1. core.manager_venue: the manager FK targeted core.manager_profile(id) only, so a row in Workspace B could link a Workspace A manager.
 *    It now targets the existing unique key core.manager_profile(id, organisation_id, workspace_id), the same invariant as the physical
 *    Workspace Schema V1. MATCH FULL refuses any NULL in the referencing columns. ON DELETE CASCADE is unchanged. The migration refuses
 *    to run when any link is not bound to a profile in the same organisation and workspace (nothing is repaired silently).
 *
 * 2. Legacy RLS: the branch 'workspace_id = current OR EXISTS(manager link)' let a manager see rows of OTHER workspaces in the same
 *    organisation (job_role: any venue manager, no link needed). Those USING clauses become organisation AND workspace, as in V1.
 *    venue_manager_staff_scope keeps its manager link, bound to the current workspace on the profile, the link and the venue.
 *
 * LEGACY_POLICIES holds the exact text pg_policies returned before this migration, so down() restores it exactly.
 */
const WORKSPACE_ONLY = "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))";
const VENUE_MANAGER_LINK = "(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS (SELECT 1 FROM ((core.manager_profile mp JOIN core.manager_venue mv ON ((mv.manager_profile_id = mp.id))) JOIN core.venue v ON ((v.id = mv.venue_id))) WHERE ((mp.id = venue_manager_staff.manager_profile_id) AND (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text)   AND (mp.workspace_id = core.current_workspace()) AND (mp.organisation_id = core.current_org())   AND (mv.workspace_id = core.current_workspace()) AND (mv.organisation_id = core.current_org())   AND (v.workspace_id = core.current_workspace()) AND (v.organisation_id = core.current_org()))))";
const VENUE_MANAGER_ROLE = "(EXISTS (SELECT 1 FROM (core.user_role ur JOIN core.role r ON ((r.id = ur.role_id))) WHERE ((ur.user_id = core.current_uid()) AND (r.key = 'venue_manager'::text))))";
const POLICIES_WITHOUT_LINK: Array<{ table: string; policy: string }> = [
  {
    "table": "attendance",
    "policy": "attendance_tenant"
  },
  {
    "table": "attendance_correction",
    "policy": "attendance_correction_tenant"
  },
  {
    "table": "job_offer",
    "policy": "job_offer_tenant"
  },
  {
    "table": "job_role",
    "policy": "job_role_tenant"
  },
  {
    "table": "manager_venue",
    "policy": "manager_venue_tenant"
  },
  {
    "table": "replacement_request",
    "policy": "replacement_request_tenant"
  },
  {
    "table": "shift",
    "policy": "shift_tenant"
  },
  {
    "table": "shift_assignment",
    "policy": "shift_assignment_tenant"
  },
  {
    "table": "shift_report",
    "policy": "shift_report_tenant"
  },
  {
    "table": "shift_request_staff",
    "policy": "shift_request_staff_tenant"
  },
  {
    "table": "venue",
    "policy": "venue_tenant"
  }
];
const LEGACY_POLICIES: Record<string, { table: string; policy: string; using: string; withCheck: string | null }> = {
  "attendance.attendance_tenant": {
    "table": "attendance",
    "policy": "attendance_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM ((core.shift s\n     JOIN core.manager_venue mv ON ((mv.venue_id = s.venue_id)))\n     JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id)))\n  WHERE ((s.id = attendance.shift_id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "attendance_correction.attendance_correction_tenant": {
    "table": "attendance_correction",
    "policy": "attendance_correction_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM (((core.attendance a\n     JOIN core.shift s ON ((s.id = a.shift_id)))\n     JOIN core.manager_venue mv ON ((mv.venue_id = s.venue_id)))\n     JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id)))\n  WHERE ((a.id = attendance_correction.attendance_id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "job_offer.job_offer_tenant": {
    "table": "job_offer",
    "policy": "job_offer_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM (((core.shift_assignment sa\n     JOIN core.shift s ON ((s.id = sa.shift_id)))\n     JOIN core.manager_venue mv ON ((mv.venue_id = s.venue_id)))\n     JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id)))\n  WHERE ((sa.id = job_offer.shift_assignment_id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "job_role.job_role_tenant": {
    "table": "job_role",
    "policy": "job_role_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM core.manager_profile mp\n  WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.type = 'venue'::text))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "manager_venue.manager_venue_tenant": {
    "table": "manager_venue",
    "policy": "manager_venue_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM core.manager_profile mp\n  WHERE ((mp.id = manager_venue.manager_profile_id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "replacement_request.replacement_request_tenant": {
    "table": "replacement_request",
    "policy": "replacement_request_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM ((core.shift s\n     JOIN core.manager_venue mv ON ((mv.venue_id = s.venue_id)))\n     JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id)))\n  WHERE ((s.id = replacement_request.shift_id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "shift.shift_tenant": {
    "table": "shift",
    "policy": "shift_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM (core.manager_venue mv\n     JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id)))\n  WHERE ((mv.venue_id = shift.venue_id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "shift_assignment.shift_assignment_tenant": {
    "table": "shift_assignment",
    "policy": "shift_assignment_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM ((core.shift s\n     JOIN core.manager_venue mv ON ((mv.venue_id = s.venue_id)))\n     JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id)))\n  WHERE ((s.id = shift_assignment.shift_id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "shift_report.shift_report_tenant": {
    "table": "shift_report",
    "policy": "shift_report_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM ((core.shift s\n     JOIN core.manager_venue mv ON ((mv.venue_id = s.venue_id)))\n     JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id)))\n  WHERE ((s.id = shift_report.shift_id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "shift_request_staff.shift_request_staff_tenant": {
    "table": "shift_request_staff",
    "policy": "shift_request_staff_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM ((core.shift s\n     JOIN core.manager_venue mv ON ((mv.venue_id = s.venue_id)))\n     JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id)))\n  WHERE ((s.id = shift_request_staff.shift_id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "venue.venue_tenant": {
    "table": "venue",
    "policy": "venue_tenant",
    "using": "((organisation_id = core.current_org()) AND ((workspace_id = core.current_workspace()) OR (EXISTS ( SELECT 1\n   FROM (core.manager_venue mv\n     JOIN core.manager_profile mp ON ((mp.id = mv.manager_profile_id)))\n  WHERE ((mv.venue_id = venue.id) AND (mp.user_id = core.current_uid()))))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))"
  },
  "venue_manager_staff.venue_manager_staff_scope": {
    "table": "venue_manager_staff",
    "policy": "venue_manager_staff_scope",
    "using": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS ( SELECT 1\n   FROM ((core.manager_profile mp\n     JOIN core.manager_venue mv ON ((mv.manager_profile_id = mp.id)))\n     JOIN core.venue v ON ((v.id = mv.venue_id)))\n  WHERE ((mp.id = venue_manager_staff.manager_profile_id) AND (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text) AND (v.organisation_id = venue_manager_staff.organisation_id) AND (v.workspace_id = venue_manager_staff.workspace_id)))))",
    "withCheck": "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS ( SELECT 1\n   FROM ((core.manager_profile mp\n     JOIN core.manager_venue mv ON ((mv.manager_profile_id = mp.id)))\n     JOIN core.venue v ON ((v.id = mv.venue_id)))\n  WHERE ((mp.id = venue_manager_staff.manager_profile_id) AND (mp.user_id = core.current_uid()) AND (mp.type = 'venue'::text) AND (v.organisation_id = venue_manager_staff.organisation_id) AND (v.workspace_id = venue_manager_staff.workspace_id)))) AND (EXISTS ( SELECT 1\n   FROM (core.user_role ur\n     JOIN core.role r ON ((r.id = ur.role_id)))\n  WHERE ((ur.user_id = core.current_uid()) AND (r.key = 'venue_manager'::text)))))"
  }
};
const LEGACY_MANAGER_VENUE_FK = 'FOREIGN KEY (manager_profile_id) REFERENCES core.manager_profile(id) ON DELETE CASCADE';
const HARDENED_MANAGER_VENUE_FK = 'FOREIGN KEY (manager_profile_id, organisation_id, workspace_id) REFERENCES core.manager_profile(id, organisation_id, workspace_id) MATCH FULL ON DELETE CASCADE';
const PREFLIGHT_UNBOUND_LINKS =
  'SELECT count(*)::int AS n FROM core.manager_venue mv WHERE NOT EXISTS (' +
  '  SELECT 1 FROM core.manager_profile mp WHERE mp.id = mv.manager_profile_id AND mp.organisation_id = mv.organisation_id AND mp.workspace_id = mv.workspace_id)';

export class ManagerVenueWorkspaceBinding1786677200000 implements MigrationInterface {
  name = 'ManagerVenueWorkspaceBinding1786677200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // manager_venue is FORCE RLS: an unscoped count sees no rows. Run the preflight per organisation under that organisation's context.
    const orgs: Array<{ id: string }> = await queryRunner.query('SELECT id FROM core.organisation');
    let unbound = 0;
    for (const org of orgs) {
      await queryRunner.query("SELECT set_config('rab.organisation_id', $1, true)", [org.id]);
      const row = await queryRunner.query(PREFLIGHT_UNBOUND_LINKS);
      unbound += row[0].n;
    }
    if (unbound !== 0) {
      throw new Error('manager_venue has ' + unbound + ' row(s) not bound to a profile in the same organisation and workspace; refusing to add the constraint');
    }
    await queryRunner.query('ALTER TABLE core.manager_venue DROP CONSTRAINT manager_venue_manager_profile_id_fkey');
    await queryRunner.query('ALTER TABLE core.manager_venue ADD CONSTRAINT manager_venue_manager_profile_workspace_fkey ' + HARDENED_MANAGER_VENUE_FK);
    for (const p of POLICIES_WITHOUT_LINK) {
      await queryRunner.query('ALTER POLICY "' + p.policy + '" ON core.' + p.table + ' USING (' + WORKSPACE_ONLY + ')');
    }
    await queryRunner.query(
      'ALTER POLICY "venue_manager_staff_scope" ON core.venue_manager_staff USING (' + VENUE_MANAGER_LINK + ') WITH CHECK ((' + VENUE_MANAGER_LINK + ') AND ' + VENUE_MANAGER_ROLE + ')',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const key of Object.keys(LEGACY_POLICIES)) {
      const legacy = LEGACY_POLICIES[key]!;
      const check = legacy.withCheck ? ' WITH CHECK (' + legacy.withCheck + ')' : '';
      await queryRunner.query('ALTER POLICY "' + legacy.policy + '" ON core.' + legacy.table + ' USING (' + legacy.using + ')' + check);
    }
    await queryRunner.query('ALTER TABLE core.manager_venue DROP CONSTRAINT manager_venue_manager_profile_workspace_fkey');
    await queryRunner.query('ALTER TABLE core.manager_venue ADD CONSTRAINT manager_venue_manager_profile_id_fkey ' + LEGACY_MANAGER_VENUE_FK);
  }
}
