-- READ-ONLY audit of legacy staff_profile rows with no workspace (Hyper Workspace Phase 3).
-- Run as the owner against the target database. It changes nothing and assigns no workspace.
-- Every row listed here is AMBIGUOUS until a human reviews it: a NULL workspace is never auto-filled from
-- created_by, from another profile, or from a venue. Resolve each row deliberately before any production migration.
--
-- Usage:  psql "$DATABASE_URL_UNPOOLED" -f audit-null-workspace-staff.sql

\echo '== count and organisations'
SELECT count(*) AS null_workspace_staff,
       count(DISTINCT organisation_id) AS organisations
  FROM core.staff_profile
 WHERE workspace_id IS NULL;

\echo '== per row (for manual review)'
SELECT sp.id                 AS staff_profile_id,
       sp.organisation_id,
       sp.user_id,
       sp.created_by,
       sp.staff_ref,
       sp.created_at,
       u.status              AS account_status,
       -- A hint only, never an authority: the creator's workspace if the creator owns exactly one.
       (SELECT count(*) FROM core.manager_workspace w WHERE w.owner_user_id = sp.created_by) AS creator_owned_workspaces,
       'AMBIGUOUS — manual review required' AS disposition
  FROM core.staff_profile sp
  LEFT JOIN core."user" u ON u.id = sp.user_id
 WHERE sp.workspace_id IS NULL
 ORDER BY sp.organisation_id, sp.created_at;

\echo '== constraint state'
SELECT conname, convalidated
  FROM pg_constraint
 WHERE conrelid = 'core.staff_profile'::regclass
   AND conname = 'staff_profile_workspace_required';
