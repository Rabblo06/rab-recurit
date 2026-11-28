// sql-injection-reviewed-file: SQL definition / check module (database layer). Every interpolation is a code constant of this repository (schema, table and policy names, md5 constants) or a validated identifier; no request or row data reaches these templates.
/**
 * DRAFT — NEW SQL, owner SQL review FIRST (owner decision 51, 2026-11-21). The database half of "nobody administers their own
 * pay record": the caller may never write the payslip whose staff member they are, nor add a document to it. Used by
 * migration PayslipOwnPayRls1786723000000 (core copies, the ones every request uses while HWS is off) and, later, by a 0.7.0
 * workspace command for the `workspace_*` copies (that half needs a structure level and waits for the 0.7.0 chain).
 *
 * Only WITH CHECK changes (never USING): a refused row must raise 42501, not silently update nothing. Each new expression is
 * the reviewed old one with ONE extra conjunct appended, so it can only narrow.
 *  - `payslip_update` WITH CHECK  … AND NOT (the payslip's staff profile belongs to the caller)
 *  - `payslip_document_insert` WITH CHECK … AND NOT (the document's payslip's staff profile belongs to the caller)
 * The sub-selects only ever need to see the CALLER'S OWN staff profile (always readable to them), and the payslip row,
 * which the policy already requires the caller to read as a payroll manager of the workspace.
 */

const SCHEMA = /^(core|workspace_[0-9a-f]{32})$/;

function qualified(schema: string): string {
  if (!SCHEMA.test(schema)) throw new Error('payslip-own-pay-rls: invalid schema');
  return schema === 'core' ? 'core' : `"${schema}"`;
}

const TENANT = `(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())`;
const PAYROLL_MANAGER = `(EXISTS ( SELECT 1 FROM core.manager_profile mp WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org())
  AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text))))`;

/** The pre-existing mark-paid clause of payslip_update (1786719200000), unchanged. */
function paidByNotStaff(q: string): string {
  return `((paid_by IS NULL) OR (NOT (EXISTS ( SELECT 1 FROM ${q}.staff_profile sp WHERE ((sp.id = payslip.staff_profile_id) AND (sp.user_id = payslip.paid_by)
  AND (sp.organisation_id = core.current_org()) AND (sp.workspace_id = core.current_workspace()))))))`;
}

/** Decision 51: the payslip row's staff member is not the caller. */
export function payslipNotOwnSql(schema: string): string {
  const q = qualified(schema);
  return `(NOT (EXISTS ( SELECT 1 FROM ${q}.staff_profile sp WHERE ((sp.id = payslip.staff_profile_id) AND (sp.user_id = core.current_uid())))))`;
}

/** Decision 51: the document's payslip does not belong to the caller. */
export function payslipDocumentNotOwnSql(schema: string): string {
  const q = qualified(schema);
  return `(NOT (EXISTS ( SELECT 1 FROM (${q}.payslip ps JOIN ${q}.staff_profile sp ON ((sp.id = ps.staff_profile_id)))
  WHERE ((ps.id = payslip_document.payslip_id) AND (sp.user_id = core.current_uid())))))`;
}

/** payslip_update WITH CHECK before (1786719200000) and after (decision 51). */
export function payslipUpdateCheckSql(schema: string, ownPayRefused: boolean): string {
  const q = qualified(schema);
  return `(${TENANT} AND ${PAYROLL_MANAGER} AND ${paidByNotStaff(q)}${ownPayRefused ? ` AND ${payslipNotOwnSql(schema)}` : ''})`;
}

/** payslip_document_insert WITH CHECK before (1786719200000) and after (decision 51). */
export function payslipDocumentInsertCheckSql(schema: string, ownPayRefused: boolean): string {
  return `(${TENANT} AND ${PAYROLL_MANAGER} AND (uploaded_by = core.current_uid())${ownPayRefused ? ` AND ${payslipDocumentNotOwnSql(schema)}` : ''})`;
}

/** The two statements, for `schema` (only the WITH CHECK expression of each policy changes). */
export function payslipOwnPayAlterSql(schema: string, ownPayRefused: boolean): string {
  const q = qualified(schema);
  return `ALTER POLICY payslip_update ON ${q}.payslip WITH CHECK ${payslipUpdateCheckSql(schema, ownPayRefused)};
ALTER POLICY payslip_document_insert ON ${q}.payslip_document WITH CHECK ${payslipDocumentInsertCheckSql(schema, ownPayRefused)};`;
}

/**
 * The semantic-posture hashes (posture-drift/semantic-posture.ts: md5 of pg_get_expr with runs of whitespace collapsed) of
 * one core policy's USING and WITH CHECK, with its shape. No row when the policy is missing.
 */
export function corePolicyStateSql(table: 'payslip' | 'payslip_document', policy: 'payslip_update' | 'payslip_document_insert'): string {
  return `SELECT pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '\\s+', ' ', 'g')) AS using_hash,
       pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '\\s+', ' ', 'g')) AS check_hash,
       p.polpermissive AS permissive, p.polcmd::text AS cmd, p.polroles = ARRAY[0]::pg_catalog.oid[] AS to_public
  FROM pg_catalog.pg_policy p
 WHERE p.polrelid = 'core.${table}'::pg_catalog.regclass AND p.polname = '${policy}'`;
}

/** core.payslip's payslip_update as PostgreSQL deparses it (pg_get_expr, whitespace collapsed). */
export const CORE_PAYSLIP_UPDATE_USING_DEPARSED =
  "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS ( SELECT 1 FROM core.manager_profile mp WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text)))))";
export const CORE_PAYSLIP_UPDATE_CHECK_BEFORE_DEPARSED =
  "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS ( SELECT 1 FROM core.manager_profile mp WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text)))) AND ((paid_by IS NULL) OR (NOT (EXISTS ( SELECT 1 FROM core.staff_profile sp WHERE ((sp.id = payslip.staff_profile_id) AND (sp.user_id = payslip.paid_by) AND (sp.organisation_id = core.current_org()) AND (sp.workspace_id = core.current_workspace())))))))";
export const CORE_PAYSLIP_UPDATE_CHECK_AFTER_DEPARSED =
  "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS ( SELECT 1 FROM core.manager_profile mp WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text)))) AND ((paid_by IS NULL) OR (NOT (EXISTS ( SELECT 1 FROM core.staff_profile sp WHERE ((sp.id = payslip.staff_profile_id) AND (sp.user_id = payslip.paid_by) AND (sp.organisation_id = core.current_org()) AND (sp.workspace_id = core.current_workspace())))))) AND (NOT (EXISTS ( SELECT 1 FROM core.staff_profile sp WHERE ((sp.id = payslip.staff_profile_id) AND (sp.user_id = core.current_uid()))))))";

/** core.payslip_document's payslip_document_insert as PostgreSQL deparses it. */
export const CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_BEFORE_DEPARSED =
  "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS ( SELECT 1 FROM core.manager_profile mp WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text)))) AND (uploaded_by = core.current_uid()))";
export const CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_AFTER_DEPARSED =
  "((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()) AND (EXISTS ( SELECT 1 FROM core.manager_profile mp WHERE ((mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.workspace_id = core.current_workspace()) AND (mp.type <> 'venue'::text)))) AND (uploaded_by = core.current_uid()) AND (NOT (EXISTS ( SELECT 1 FROM (core.payslip ps JOIN core.staff_profile sp ON ((sp.id = ps.staff_profile_id))) WHERE ((ps.id = payslip_document.payslip_id) AND (sp.user_id = core.current_uid()))))))";

/** md5 of the deparsed expressions above (the semantic goldens' hashes). */
export const PAYSLIP_OWN_PAY_HASHES = Object.freeze({
  updateUsing: 'de27c66e727763f94d047d16e9656077',
  updateCheckBefore: '0acfcaafc5cba7f7d7657ef38dd0b2dd',
  updateCheckAfter: '206abc57e88c0608a1d7916bbff68b8f',
  documentInsertCheckBefore: '03f074acfde1096d657162299dc67442',
  documentInsertCheckAfter: '108c6641f1d495176ee0a12b54bdcd0d',
});

/**
 * The privilege-drift lines migration-security-check.ts reviews for PayslipOwnPayRls1786723000000 (its REVIEWED_MIGRATION_DRIFT
 * entry): both core policies before and after, as that harness prints them. Expected output of a check, not a query.
 */
export const CORE_PAYSLIP_OWN_PAY_REVIEWED_DRIFT: readonly string[] = Object.freeze([
  `- policy|payslip|payslip_update|w|permissive=true|roles=public|using=${CORE_PAYSLIP_UPDATE_USING_DEPARSED}|check=${CORE_PAYSLIP_UPDATE_CHECK_BEFORE_DEPARSED}`,
  `+ policy|payslip|payslip_update|w|permissive=true|roles=public|using=${CORE_PAYSLIP_UPDATE_USING_DEPARSED}|check=${CORE_PAYSLIP_UPDATE_CHECK_AFTER_DEPARSED}`,
  `- policy|payslip_document|payslip_document_insert|a|permissive=true|roles=public|using=|check=${CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_BEFORE_DEPARSED}`,
  `+ policy|payslip_document|payslip_document_insert|a|permissive=true|roles=public|using=|check=${CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_AFTER_DEPARSED}`,
]);
