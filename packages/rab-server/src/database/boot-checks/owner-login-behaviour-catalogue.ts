/**
 * The reviewed BEHAVIOUR-CHANGE CATALOGUE of the owner-login architecture (owner's final decision 2026-11-04, Option A,
 * permanent). Every protection the former restricted runtime logins (crewflow_app / crewflow_worker) gave and the single
 * owner login crewflow_owner cannot keep is listed here with a severity, its status and the test that REPRODUCES the
 * difference against a real database built with the owner-login bootstrap:
 *   src/__tests__/integration/owner-login-behaviour-catalogue.integration.spec.ts (one `it` per id, titled `<id>: …`).
 *
 * A difference is NEVER recorded as "passing". The tests assert what the owner login CAN now do (the loss), so a test
 * that starts failing means the behaviour changed again and the entry must be reviewed.
 *
 * Status:
 *   accepted-s2           — listed among the consequences the owner accepted in the final prompt §2;
 *   accepted-owner        — accepted by a later, explicit owner decision (date in the entry), with app-level protection;
 *   needs-owner-approval  — NOT listed in §2: STOPPED for explicit owner approval (addendum "Protections that cannot be
 *                           kept with one login"); the code records it (boot warning, gate message) but nothing claims it is fine;
 *   mitigated             — a new control narrows it on NORMAL code paths (never against injection; residual stated);
 *   behaviour-change      — a functional change with no security loss (documented so reviewers see it).
 * Mirrored in THREAT-MODEL.md (PT-01 and its table). Changing an entry is a reviewed change.
 */
export type CatalogueStatus = 'accepted-s2' | 'accepted-owner' | 'needs-owner-approval' | 'mitigated' | 'behaviour-change';
export type CatalogueSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface CatalogueEntry {
  id: string;
  title: string;
  severity: CatalogueSeverity;
  status: CatalogueStatus;
  /** M0 / review finding ids this entry corresponds to. */
  refs: readonly string[];
  before: string;
  after: string;
  /** Controls that narrow it, and what they do not cover. */
  controls: string;
}

export const OWNER_LOGIN_BEHAVIOUR_CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  {
    id: 'BC-01',
    title: 'The runtime login is a member of the owner roles (injected SQL runs with owner privileges)',
    severity: 'CRITICAL',
    status: 'accepted-s2',
    refs: ['G-02', 'PT-01'],
    before: 'crewflow_app owned nothing and was a member of no owner role; boot gate 1 refused any owner-role membership.',
    after: 'crewflow_owner INHERITs rab_secure_owner and crewflow: ALTER/DROP POLICY, NO FORCE, DISABLE TRIGGER, CREATE OR REPLACE FUNCTION all succeed for an injected statement.',
    controls: 'FORCE on every tenant and pre-auth table binds normal paths; the semantic posture monitor detects policy / function / trigger / RLS-flag rewrites afterwards (never prevents them).',
  },
  {
    id: 'BC-02',
    title: 'The legacy restricted logins are schema roles; connecting as them is refused',
    severity: 'INFO',
    status: 'behaviour-change',
    refs: ['addendum'],
    before: 'The API/CLI had to connect as crewflow_app, a global-mode Worker as crewflow_worker, the provisioner as crewflow.',
    after: 'Every process connects as crewflow_owner; a connection as crewflow_app / crewflow_worker / crewflow is refused by the boot gate and assertRuntimeDbRole.',
    controls: 'n/a (no protection is lost by the refusal itself).',
  },
  {
    id: 'BC-03',
    title: 'Cross-organisation authentication data (password hashes, TOTP ciphertext, token hashes)',
    severity: 'CRITICAL',
    status: 'accepted-s2',
    refs: ['G-01'],
    before: 'crewflow_app saw zero pre-auth rows without tenant context (not the owner).',
    after: 'Without M-T1 a logic bug alone exposed every tenant. With M-T1 normal paths see zero rows without context; one injected SET ROLE rab_secure_owner (or set_config role) reads every tenant.',
    controls: 'M-T1 (FORCE + owner-only definer policy); pool safety (RESET ROLE on checkout and per tenant transaction). Injection: not covered.',
  },
  {
    id: 'BC-04',
    title: 'Account takeover with MFA bypass, platform administrators included',
    severity: 'CRITICAL',
    status: 'accepted-s2',
    refs: ['G-03', 'G-13'],
    before: 'The MFA column guard refused crewflow_app; crewflow_app could not SET ROLE or DISABLE TRIGGER.',
    after: 'An injected SET LOCAL ROLE rab_secure_owner (or DISABLE TRIGGER user_mfa_columns_guard) clears totp_enabled and swaps password_hash for any user.',
    controls: 'Drift monitor detects a disabled trigger; external audit sink keeps the evidence off-database. Not prevented.',
  },
  {
    id: 'BC-05',
    title: 'Policy modification (ALTER POLICY … USING (true), additive backdoor policy, NO FORCE)',
    severity: 'CRITICAL',
    status: 'accepted-s2',
    refs: ['G-02'],
    before: 'Only the table owner could alter policies; no runtime login owned a table.',
    after: 'The owner login can rewrite any policy while FORCE stays on (a FORCE-only check cannot see it).',
    controls: 'Semantic posture monitor (policy qual / with_check hashed, boot + periodic). Detection only.',
  },
  {
    id: 'BC-06',
    title: 'Object deletion (DROP SCHEMA core CASCADE, DROP TABLE)',
    severity: 'CRITICAL',
    status: 'accepted-s2',
    refs: ['G-02', '§6.2-9'],
    before: 'crewflow_app could not drop any object.',
    after: 'One statement as the owner login can destroy the schema.',
    controls: 'PITR (tested restore) only.',
  },
  {
    id: 'BC-07',
    title: 'Audit tampering: audit_log insert-only is no longer enforceable in the database',
    severity: 'HIGH',
    status: 'accepted-s2',
    refs: ['G-05'],
    before: 'UPDATE/DELETE/TRUNCATE revoked from every runtime role; crewflow_app could not re-grant.',
    after: 'The owner login re-grants itself UPDATE/DELETE/TRUNCATE and rewrites or truncates any tenant\'s audit rows.',
    controls: 'External append-only audit sink (mandatory in production); drift monitor hashes the audit_log ACL.',
  },
  {
    id: 'BC-08',
    title: 'DBA-01 lost: the API can run the Worker-only dispatch-claim functions',
    severity: 'MEDIUM',
    status: 'accepted-owner',
    refs: ['G-08', 'DBA-01', 'D0-A1', 'owner decision 2026-11-05 (like Twenty)'],
    before: 'Only crewflow_worker held EXECUTE; boot gate 8 refused an API whose login could execute a claim function.',
    after: 'crewflow_owner executes every claim / release function through its ownership (rab_secure_owner); gate 8 records a BC-08 warning on every API/CLI boot instead of refusing.',
    controls: 'Lease fencing prevents double sends; worst case is lease stealing delaying dispatch 15–60 s (M0-D). Accepted by the owner 2026-11-05, like Twenty.',
  },
  {
    id: 'BC-09',
    title: 'Persistence through roles or definers that survives credential rotation',
    severity: 'CRITICAL',
    status: 'accepted-s2',
    refs: ['G-04', 'F-E2'],
    before: 'crewflow_app had no CREATEROLE and owned no function.',
    after: 'The owner login (CREATEROLE + implicit ADMIN) can create a backdoor LOGIN in rab_secure_owner, turn a NOLOGIN owner role into a password login, or trojan a SECURITY DEFINER body.',
    controls: 'Role inventory at boot and on the monitor timer (backdoor login / NOLOGIN drift refused); function bodies hashed by the monitor. Passwords of expected LOGIN roles are not visible without superuser.',
  },
  {
    id: 'BC-10',
    title: 'Direct access to worker_due_work and the dispatch pointers',
    severity: 'MEDIUM',
    status: 'accepted-owner',
    refs: ['M0-B', 'D0-A1', 'owner decision 2026-11-05 (like Twenty)'],
    before: 'crewflow_app held no privilege on core.worker_dispatch_pointer (read refused with 42501); worker_due_work was reached through definers.',
    after: 'The owner login holds the owner\'s table privileges on both: the pointer read is answered (zero rows, restrictive deny TO crewflow) instead of refused; worker_due_work is tenant-bound only since M-T1; SET ROLE rab_secure_owner reads and rewrites every tenant\'s pointers.',
    controls: 'Restrictive deny policy (normal paths) and M-T1 FORCE on worker_due_work. Injection: not covered. Accepted by the owner 2026-11-05, like Twenty.',
  },
  {
    id: 'BC-11',
    title: 'Deployment identity can be rebound by the runtime',
    severity: 'HIGH',
    status: 'accepted-owner',
    refs: ['G-06', 'N1', 'owner decision 2026-11-05 (like Twenty)'],
    before: 'core.deployment_identity_bind_gate admitted only a session that is a member of rab_secure_owner — never a runtime login.',
    after: 'The runtime login IS a member of rab_secure_owner: the API/Worker pass the bind gate and (with SET ROLE) can rewrite the marker.',
    controls:
      'Production no longer requires a deployment ID or a per-release approval token (both optional, off by default). A wrong or old image, or a staging config pointed at the production URL, migrates production with no second check; recovery from a mistaken upgrade is restore-from-backup only (old images fail closed on an upgraded database). Accepted by the owner 2026-11-05, like Twenty. Remaining controls: the migration lock, the identity and refusal gates, the posture and semantic goldens, RLS, the mandatory pre-upgrade backup (runbook), and the optional opt-in deployment ID and approval token. Also accepted (Agent 1, 0074cecb): a production deployment that declares no deployment ID skips the marker and location checks, so it does not detect a wrong, restored or cloned database; every boot writes a warning.',
  },
  {
    id: 'BC-12',
    title: 'No logical backup by the app login (PITR-only recovery)',
    severity: 'MEDIUM',
    status: 'accepted-owner',
    refs: ['G-11', 'owner decision 2026-11-05 (like Twenty)'],
    before: 'Separate migration / superuser identities could take a pg_dump; crewflow_app never had to.',
    after: 'crewflow_owner is NOBYPASSRLS: pg_dump of FORCE tables yields no rows (or refuses with --enable-row-security semantics), so the only backup is the provider\'s PITR; a post-compromise restore point carries the backdoors.',
    controls: 'PITR retention ≥ detection time with a tested restore (runbook). Accepted by the owner 2026-11-05, like Twenty.',
  },
  {
    id: 'BC-13',
    title: 'Column-level secret grants lost (password_hash, TOTP secret, recovery codes)',
    severity: 'HIGH',
    status: 'accepted-owner',
    refs: ['M0-B', 'golden column lines', 'owner decision 2026-11-05 (like Twenty)'],
    before: 'crewflow_app held column grants on core."user" / user_session / refresh_token without the secret columns: a SELECT of password_hash was refused (42501).',
    after: 'Column grants do not bind the table owner: crewflow_owner reads every column of its tenant\'s rows on normal paths.',
    controls: 'None at the database level with one login. Accepted by the owner 2026-11-05, like Twenty.',
  },
  {
    id: 'BC-14',
    title: 'Pool poisoning: a session-level SET ROLE survives COMMIT',
    severity: 'MEDIUM',
    status: 'mitigated',
    refs: ['G-09'],
    before: 'crewflow_app could not SET ROLE to anything.',
    after: 'Without a reset, one injected SET ROLE rab_secure_owner made later requests on that pooled connection run as the owner.',
    controls: 'RESET ROLE on every pool checkout and at the start of every tenant transaction, plus current_user = session_user asserted (fail closed). Residual: other session-level settings; anything injection does within its own request.',
  },
  {
    id: 'BC-15',
    title: 'Workspace registry versioning / drift columns writable by the runtime',
    severity: 'MEDIUM',
    status: 'mitigated',
    refs: ['G-10'],
    before: 'The deny-list guard refused crewflow_app.',
    after: 'Without M-T2 every non-crewflow_app role passed, crewflow_owner included.',
    controls: 'M-T2 allow-list (crewflow, rab_secure_owner, superuser) on normal paths; migrator takes SET LOCAL ROLE crewflow. Injection: SET ROLE crewflow / DISABLE TRIGGER (drift monitor detects the trigger).',
  },
  {
    id: 'BC-16',
    title: 'Credential exposure: the one URL is the owner',
    severity: 'HIGH',
    status: 'accepted-s2',
    refs: ['§6.3'],
    before: 'A leaked runtime env exposed the restricted crewflow_app credential.',
    after: 'A leaked PG_DATABASE_URL is the schema owner with CREATEROLE.',
    controls: 'Private network / allow-list + verify-full TLS; rotation is not remediation (drop unknown roles, compare the inventory).',
  },
  {
    id: 'BC-17',
    title: 'Legacy LOGIN schema roles keep their old passwords on an upgraded database',
    severity: 'MEDIUM',
    status: 'mitigated',
    refs: ['G-04', 'addendum', 'owner decision 2026-11-05: mitigate (NOLOGIN after transition)', 'Agent 1 (SHA: 80686512)', 'Agent 1 (SHA: f91f1038, crewflow_migrator)'],
    before: 'crewflow / crewflow_app / crewflow_worker were the restricted runtime logins with passwords in the deployment config.',
    after: 'They remain LOGIN (golden posture) though nothing connects as them; an old credential still logs in. The boot check cannot see passwords (pg_authid is superuser-only).',
    controls:
      "Agent 1 (80686512): crewflow and crewflow_app become NOLOGIN with PASSWORD NULL on the transition and on fresh installs; crewflow_worker becomes PASSWORD NULL. Residual: crewflow_worker remains a LOGIN role with no password; it can authenticate only via non-password methods, which the provider's pg_hba must not grant (migrations 1786721300000 / 1786721340000 assert its LOGIN, and crewflow_owner cannot administer it); only a trust / peer / cert pg_hba rule could admit it. Fresh-install residual (detection only): crewflow_owner keeps CREATEROLE plus ADMIN on crewflow / crewflow_app, so injected SQL could ALTER ROLE crewflow_app LOGIN PASSWORD to regain a persistent login; the privilege-drift snapshot and the posture golden catch login=true (a transitioned database is not exposed: crewflow_owner is NOCREATEROLE there). Rollback: roles are cluster-wide; only a fresh-cluster restore of roles.sql plus the dump brings LOGIN back. crewflow_migrator (Agent 1, f91f1038): NOLOGIN PASSWORD NULL on the transition when the role exists; residual: it keeps its memberships (rab_secure_owner and crewflow, SET + INHERIT) — a NOLOGIN member is inert, and removing it (REVOKE or DROP ROLE) would need a separate owner decision; the transition passed the second-boot posture check with it present. Proving test: PG16 lifecycle check 'transition: BC-17 the old logins are disabled (crewflow, crewflow_app, crewflow_migrator NOLOGIN without a password; crewflow_worker LOGIN without a password)'; catalogue test BC-17.",
  },
  {
    id: 'BC-18',
    title: 'The app can delete or change member invitations, login sessions and email-change requests within one tenant (7 tables)',
    severity: 'MEDIUM',
    status: 'accepted-owner',
    refs: ['X2', 'INV-1', 'owner decision 2026-11-04'],
    before:
      'crewflow_app held no DELETE (and on login_handoff, organisation_invitation, released_host_label, user_auth_identity, user_session no or only column-level INSERT / UPDATE) on these rab_secure_owner tables: a direct write was refused with 42501; definers were the write path.',
    after:
      'The owner login inherits rab_secure_owner, so a direct INSERT / UPDATE / DELETE on login_handoff, organisation_invitation, released_host_label, user_auth_identity, user_session, member_invitation and email_change_request succeeds within the bound tenant (RLS still limits it to that tenant; no context = 0 rows). Owner decision 2026-11-04: "Accepted, like Twenty." No database guard.',
    controls:
      'App-level only, like Twenty: every write to the 7 tables must stay in the reviewed owning code (tools/check-protected-table-writes.cjs, CI job protected-table-writes); M-T1 FORCE keeps it to one tenant on normal paths.',
  },
  // ── Found by Agent 5's differential runs (PR #74, twa/tests @ 7140692d); entries supplied by Agent 5, reviewed here. ──
  {
    id: 'COLGRANT-1',
    title: 'Non-secret column-level INSERT grants no longer bind the runtime login',
    severity: 'MEDIUM',
    status: 'accepted-owner',
    refs: ['C2/column-grants', 'Agent 5 COLGRANT-1', 'owner decision 2026-11-05 (like Twenty)'],
    before: "crewflow_app's column INSERT grants kept server-owned columns (id, created_at, expires_at, origin) out of the runtime's hands.",
    after:
      'The runtime login inherits the owner: it may set them (core.ai_usage id / created_at, core.ai_skill id, ai_action_proposal expires_at / created_at / id / origin); there is no INSERT parity guard (column-level INSERT parity is not reproduced).',
    controls:
      'RLS WITH CHECK and INSERT policies still hold (another user / organisation refused; a forged updated_by on organisation_ai_model_preference refused; a decided proposal refused). Not covered: server-owned column values on own-tenant rows. Accepted by the owner 2026-11-05, like Twenty.',
  },
  {
    id: 'REF-1',
    title: 'Global reference tables (core.permission, core.migrations) writable by the runtime login',
    severity: 'MEDIUM',
    status: 'accepted-owner',
    refs: ['Agent 5 REF-1', 'owner decision 2026-11-04 (like Twenty)'],
    before: 'crewflow_app held SELECT / INSERT on core.permission and SELECT on core.migrations.',
    after:
      'The runtime login inherits crewflow\'s SELECT, INSERT, UPDATE, DELETE, TRUNCATE on both; neither has RLS or organisation_id, so one statement affects every tenant. Owner decision 2026-11-04: "Under the owner login, a bug or injected SQL can change the global permission-flag table and the migration ledger (no tenant boundary; affects every tenant). Accepted, like Twenty."',
    controls:
      'No parity guard (the seed commands and the migration runner write them as the owner login). The ledger-compatible lifecycle check sees a rewritten core.migrations at the next deploy.',
  },
  {
    id: 'HL-1',
    title: 'Table privileges on the host-label namespace tables',
    severity: 'LOW',
    status: 'accepted-owner',
    refs: ['Agent 5 HL-1', 'owner decision 2026-11-05 (like Twenty)'],
    before: 'crewflow_app had no privilege on core.host_label_claim / released_host_label / reserved_host_label (42501).',
    after: 'The runtime login holds table privileges through the owner: it reads the global reserved-label list (no organisation_id) on a normal code path.',
    controls:
      'Without context it sees zero claim / quarantine rows (FORCE since M-T1, owner-only definer policy); DELETE of reserved labels is parity-guarded (42501); released_host_label is append-only for every role. Accepted by the owner 2026-11-05, like Twenty.',
  },
  {
    id: 'AI-1',
    title: 'AI governance enforced by grants is lost for the runtime login',
    severity: 'MEDIUM',
    status: 'accepted-owner',
    refs: ['Agent 5 TW-D', 'Agent 5 AI-1', 'owner decision 2026-11-05 (like Twenty)'],
    before:
      'Grants refused the runtime: ai_agent_trigger enable / run_as, standard / system agent edits, ai_skill name / is_system / organisation_id, TRUNCATE on AI tables, organisation_ai_setting.synthetic_data INSERT, EXECUTE on core.ai_dev_mark_organisation_synthetic.',
    after:
      'The runtime login holds TRUNCATE on ai_skill / ai_usage / ai_conversation / ai_action_proposal / organisation_ai_model_preference (ignores RLS), may INSERT synthetic_data, and can EXECUTE core.ai_dev_mark_organisation_synthetic (its body still refuses on a non-disposable database check, 55000).',
    controls:
      'UPDATE / DELETE parity guards on the AI tables (42501 for real changes; the guard fires first since 4caaef2a); ai_action_proposal_guard keeps content immutable for every role (23514); the EX-3 CHECK refuses enabling a trigger without approval (23514). Not covered: TRUNCATE, INSERT-time columns. Accepted by the owner 2026-11-05, like Twenty.',
  },
  {
    id: 'MFA-SESS-1',
    title: 'Runtime login could stamp a session MFA-verified by a direct UPDATE',
    severity: 'HIGH',
    status: 'mitigated',
    refs: ['Agent 5 MFA-SESS-1', 'owner decision 2026-11-04: PROTECT', 'OwnerLoginGrantParityGuards1786721420000 (4caaef2a)'],
    before: 'crewflow_app had no UPDATE on core.user_session.mfa_verified_at (42501).',
    after: "Measured on PR #74: the runtime login could UPDATE mfa_verified_at on its own tenant's sessions. Fixed in place by 4caaef2a.",
    controls:
      'A statement-level BEFORE UPDATE OF mfa_verified_at trigger refuses any UPDATE naming the column, for every role (42501); the INSERT-time check (enabled factor, not in the future) is unchanged. Residual: injection with owner privileges can disable the trigger (BC-01 / BC-04; the drift monitor detects it).',
  },
  {
    // Decision (Agent 3): its own entry, not folded into BC-08 (dispatch claims, unrelated) or BC-15 (registry versioning
    // guard, MITIGATED by M-T2): folding an open loss into a mitigated entry would have hidden it. Owner-accepted 2026-11-05.
    id: 'PROV-1',
    title: 'The workspace migrator no longer refuses the runtime login (application-layer identity check)',
    severity: 'MEDIUM',
    status: 'accepted-owner',
    refs: ['Agent 5 PROV-1', 'G-10', 'owner decision 2026-11-05 (like Twenty)'],
    before:
      'WorkspaceSchemaMigrator.assertMigrationIdentity refused crewflow_app (and any role without crewflow USAGE), so the API runtime could never migrate workspace schemas.',
    after: 'crewflow_owner holds crewflow USAGE, so assertMigrationIdentity accepts the runtime login: only deployment wiring keeps the API from running the migrator.',
    controls:
      'The ledger / registry writes still pass the M-T2 allow-list only as crewflow (the migrator takes SET LOCAL ROLE crewflow itself). Not covered: the application-layer refusal. Accepted by the owner 2026-11-05, like Twenty.',
  },
]);

/**
 * Entries still waiting for an explicit owner decision. The owner accepted BC-08, BC-10, BC-11, BC-12, BC-13, AI-1,
 * COLGRANT-1, HL-1 and PROV-1 on 2026-11-05 ("like Twenty"); BC-17 leaves this list when the legacy logins become NOLOGIN
 * after the transition (Agent 1) and is marked mitigated with its proving test.
 */
export const NEEDS_OWNER_APPROVAL_IDS: readonly string[] = OWNER_LOGIN_BEHAVIOUR_CATALOGUE.filter((e) => e.status === 'needs-owner-approval').map((e) => e.id);

/**
 * Accepted differences that stay TRACKED by the PR #9 removal gate (owner, 2026-11-05): HL-1 was under that gate before
 * its acceptance and keeps being reported there, so the final removal PR still reviews it explicitly.
 */
export const PR9_TRACKED_ACCEPTED_IDS: readonly string[] = Object.freeze(['HL-1']);
