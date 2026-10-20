/**
 * Frozen SQL shipped with migration 1786718400000 (and applied by the provisioner after `shiftReviewSignoffSql`).
 *
 * The final-timesheet worker prints each staff member's per-shift review on the FINAL PDF (owner Adolphus template,
 * 2026-10-17). The worker runs with no user identity (`rab.actor_type = 'worker'`), so `shift_staff_review_scope`
 * (shift creator / venue-linked Venue Manager) correctly hides every row from it. This adds the same narrow read the
 * worker already has on `staff_profile` (`staff_profile_worker_scan`, 1786676600000): SELECT only, worker actor only,
 * still bound to the transaction's organisation AND workspace. No write path changes; user sessions are unaffected
 * because they never carry `rab.actor_type = 'worker'` (set only by `TenantContextService` for worker contexts).
 */
export function shiftReviewWorkerScanSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const t = `${schema === 'core' ? 'core' : `"${schema}"`}.shift_staff_review`;
  return `
DROP POLICY IF EXISTS shift_staff_review_worker_scan ON ${t};
CREATE POLICY shift_staff_review_worker_scan ON ${t} AS PERMISSIVE FOR SELECT TO PUBLIC
  USING ((current_setting('rab.actor_type'::text, true) = 'worker'::text) AND (organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()));
`;
}
