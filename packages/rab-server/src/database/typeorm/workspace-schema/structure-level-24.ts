// sql-injection-reviewed-file: SQL definition module (database layer). Every interpolation is a code constant of this repository (the frozen template, the sentinel schema name and a policy name); no request or row data reaches these templates.
import { composeServerPathTemplateLevel23 } from './structure-level-23';
import { SERVER_PATH_SENTINEL_SCHEMA } from './v1/server-path-template';
import { SHIFT_TEAM_SELECT_POLICY, shiftTeamSelectMultiRoleSql } from '../../../engine/core-modules/upgrade/upgrade-commands/0-7/staff-profile-shift-team-multi-role';

/**
 * DRAFT — NEW SQL, owner SQL review FIRST (#205). FROZEN with migration StaffShiftTeamMultiRole1786721600000 once approved.
 * Structure level 24 (the staff Teams list for a staff user who also holds another role):
 *  - `core.provision_workspace(uuid)`: the guarded v3 body over template(20) + level 21 + level 22 + level 23
 *    (structure-level-23.ts) with the level-24 command's ALTER POLICY appended, recording module_version 24 and checking the
 *    declared level-24 v2 fingerprint. In the provisioning transaction the policy was created by the template a few statements
 *    earlier, so the ALTER only rewrites its USING expression.
 *  - `core.verify_workspace_schema_v1(uuid)`: UNCHANGED (it counts policies, not their expressions): the per-level v2
 *    fingerprint is what proves the new predicate.
 */
export function composeServerPathTemplateLevel24(): string {
  return [composeServerPathTemplateLevel23(), shiftTeamSelectMultiRoleSql(SERVER_PATH_SENTINEL_SCHEMA)].join(';\n');
}

/**
 * The semantic-posture hash of a policy's USING expression (posture-drift/semantic-posture.ts: md5 of pg_get_expr with runs
 * of whitespace collapsed), for core.staff_profile's shift-team policy. NULL when the policy does not exist.
 */
export const CORE_SHIFT_TEAM_POLICY_SQL = `SELECT pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g')) AS using_hash,
       p.polpermissive AS permissive, p.polcmd::text AS cmd, p.polroles = ARRAY[0]::pg_catalog.oid[] AS to_public, p.polwithcheck IS NULL AS no_check
  FROM pg_catalog.pg_policy p
 WHERE p.polrelid = 'core.staff_profile'::pg_catalog.regclass AND p.polname = '${SHIFT_TEAM_SELECT_POLICY}'`;

/** USING hash of the 1786718100000 core policy (`rab.role = 'staff'`); equal to the semantic goldens' line before level 24. */
export const CORE_SHIFT_TEAM_USING_HASH_EQUALITY = '97bbab50a17fb6dd93b9322440dfda19';
/** USING hash of the level-24 core policy (`'staff' = ANY (string_to_array(rab.role, ','))`); pinned by the goldens. */
export const CORE_SHIFT_TEAM_USING_HASH_MEMBERSHIP = 'c582fe8de552fdc3c359dd8ae1d4e4bc';

/**
 * USING hash of the 1786718100000 workspace-schema policy (`rab.role = 'staff'`), with the schema name canonicalised to
 * `workspace_*` (the security-posture golden's workspace-template form) and runs of whitespace collapsed.
 */
export const WORKSPACE_SHIFT_TEAM_USING_HASH_EQUALITY = 'bf70e2e8af36d08d7cf2b69b0cf89218';

/**
 * down() guard (same rule as levels 21-23), FAIL CLOSED (DB review of #243): counts the workspace schemas whose shift-team
 * policy is NOT the known level-23 equality form, whatever it is instead (the level-24 membership predicate, a hand-altered
 * one, or the same predicate deparsed differently by a future major). down() refuses while any remains: a level-23
 * provision body (expecting the equality fingerprint) next to such workspaces would make the fleet's structure
 * inconsistent. Catalog only. Not the registry's module_version: core.workspace_schema_registry is FORCE RLS with a tenant
 * policy, so a non-superuser migrator with no tenant bound would always count 0 there (a check that cannot fire).
 */
export const LEVEL_24_WORKSPACES_SQL = `SELECT pg_catalog.count(*)::int AS n
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname ~ '^workspace_[0-9a-f]{32}$' AND c.relname = 'staff_profile' AND p.polname = '${SHIFT_TEAM_SELECT_POLICY}'
   AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), n.nspname, 'workspace_*'), '\\s+', ' ', 'g'))
       IS DISTINCT FROM '${WORKSPACE_SHIFT_TEAM_USING_HASH_EQUALITY}'`;

/**
 * The provision_workspace body a direction may replace (DB review of #243): up() only the level-23 body (#177's literal),
 * down() only this migration's level-24 body. `$1` = the literal that must be present, `$2` = the one that must be absent.
 */
export const PROVISION_PREDECESSOR_SQL = `SELECT pg_catalog.strpos(p.prosrc, $1) > 0 AND pg_catalog.strpos(p.prosrc, $2) = 0 AS ok
  FROM pg_catalog.pg_proc p
 WHERE p.oid = 'core.provision_workspace(uuid)'::pg_catalog.regprocedure`;

/**
 * The two privilege-drift lines migration-security-check.ts reviews for StaffShiftTeamMultiRole1786721600000 (its
 * REVIEWED_MIGRATION_DRIFT entry): the core policy before and after, as that harness prints it (pg_get_expr, whitespace
 * collapsed). Expected output of a check, not a query; kept here because it quotes the deparsed core.shift /
 * core.shift_assignment references, and workspace-schema/** is outside the workspace-table qualification ratchet.
 */
export const CORE_SHIFT_TEAM_REVIEWED_DRIFT: readonly string[] = Object.freeze([
  "- policy|staff_profile|staff_profile_shift_team_select|r|permissive=true|roles=public|using=((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (current_setting('rab.role'::text, true) = 'staff'::text) AND (EXISTS ( SELECT 1 FROM ((core.shift_assignment peer JOIN core.shift_assignment own ON (((own.shift_id = peer.shift_id) AND (own.organisation_id = peer.organisation_id) AND (own.workspace_id = peer.workspace_id)))) JOIN core.shift s ON (((s.id = peer.shift_id) AND (s.organisation_id = peer.organisation_id) AND (s.workspace_id = peer.workspace_id)))) WHERE ((peer.staff_profile_id = staff_profile.id) AND (peer.organisation_id = core.current_org()) AND (peer.workspace_id = core.current_workspace()) AND (peer.shift_id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid) AND (own.staff_profile_id = (NULLIF(current_setting('rab.team_staff_id'::text, true), ''::text))::uuid) AND (own.status = 'confirmed'::text) AND (peer.status = 'confirmed'::text) AND (s.status <> ALL (ARRAY['cancelled'::text, 'completed'::text]))))))|check=",
  "+ policy|staff_profile|staff_profile_shift_team_select|r|permissive=true|roles=public|using=((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND ('staff'::text = ANY (string_to_array(current_setting('rab.role'::text, true), ','::text))) AND (EXISTS ( SELECT 1 FROM ((core.shift_assignment peer JOIN core.shift_assignment own ON (((own.shift_id = peer.shift_id) AND (own.organisation_id = peer.organisation_id) AND (own.workspace_id = peer.workspace_id)))) JOIN core.shift s ON (((s.id = peer.shift_id) AND (s.organisation_id = peer.organisation_id) AND (s.workspace_id = peer.workspace_id)))) WHERE ((peer.staff_profile_id = staff_profile.id) AND (peer.organisation_id = core.current_org()) AND (peer.workspace_id = core.current_workspace()) AND (peer.shift_id = (NULLIF(current_setting('rab.team_shift_id'::text, true), ''::text))::uuid) AND (own.staff_profile_id = (NULLIF(current_setting('rab.team_staff_id'::text, true), ''::text))::uuid) AND (own.status = 'confirmed'::text) AND (peer.status = 'confirmed'::text) AND (s.status <> ALL (ARRAY['cancelled'::text, 'completed'::text]))))))|check=",
]);
