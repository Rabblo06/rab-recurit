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
    status: 'needs-owner-approval',
    refs: ['G-08', 'DBA-01', 'D0-A1'],
    before: 'Only crewflow_worker held EXECUTE; boot gate 8 refused an API whose login could execute a claim function.',
    after: 'crewflow_owner executes every claim / release function through its ownership (rab_secure_owner); gate 8 records a BC-08 warning on every API/CLI boot instead of refusing.',
    controls: 'Lease fencing prevents double sends; worst case is lease stealing delaying dispatch 15–60 s (M0-D). NEEDS OWNER APPROVAL.',
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
    status: 'needs-owner-approval',
    refs: ['M0-B', 'D0-A1'],
    before: 'crewflow_app held no privilege on core.worker_dispatch_pointer (read refused with 42501); worker_due_work was reached through definers.',
    after: 'The owner login holds the owner\'s table privileges on both: the pointer read is answered (zero rows, restrictive deny TO crewflow) instead of refused; worker_due_work is tenant-bound only since M-T1; SET ROLE rab_secure_owner reads and rewrites every tenant\'s pointers.',
    controls: 'Restrictive deny policy (normal paths) and M-T1 FORCE on worker_due_work. Injection: not covered. NEEDS OWNER APPROVAL.',
  },
  {
    id: 'BC-11',
    title: 'Deployment identity can be rebound by the runtime',
    severity: 'HIGH',
    status: 'needs-owner-approval',
    refs: ['G-06', 'N1'],
    before: 'core.deployment_identity_bind_gate admitted only a session that is a member of rab_secure_owner — never a runtime login.',
    after: 'The runtime login IS a member of rab_secure_owner: the API/Worker pass the bind gate and (with SET ROLE) can rewrite the marker.',
    controls: 'Deployment id mandatory after the first bind; bind only on an empty database (Agent 1, D6). NEEDS OWNER APPROVAL.',
  },
  {
    id: 'BC-12',
    title: 'No logical backup by the app login (PITR-only recovery)',
    severity: 'MEDIUM',
    status: 'needs-owner-approval',
    refs: ['G-11'],
    before: 'Separate migration / superuser identities could take a pg_dump; crewflow_app never had to.',
    after: 'crewflow_owner is NOBYPASSRLS: pg_dump of FORCE tables yields no rows (or refuses with --enable-row-security semantics), so the only backup is the provider\'s PITR; a post-compromise restore point carries the backdoors.',
    controls: 'PITR retention ≥ detection time with a tested restore (runbook). NEEDS OWNER APPROVAL.',
  },
  {
    id: 'BC-13',
    title: 'Column-level secret grants lost (password_hash, TOTP secret, recovery codes)',
    severity: 'HIGH',
    status: 'needs-owner-approval',
    refs: ['M0-B', 'golden column lines'],
    before: 'crewflow_app held column grants on core."user" / user_session / refresh_token without the secret columns: a SELECT of password_hash was refused (42501).',
    after: 'Column grants do not bind the table owner: crewflow_owner reads every column of its tenant\'s rows on normal paths.',
    controls: 'None at the database level with one login. NEEDS OWNER APPROVAL.',
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
    status: 'needs-owner-approval',
    refs: ['G-04', 'addendum'],
    before: 'crewflow / crewflow_app / crewflow_worker were the restricted runtime logins with passwords in the deployment config.',
    after: 'They remain LOGIN (golden posture) though nothing connects as them; an old credential still logs in. The boot check cannot see passwords (pg_authid is superuser-only).',
    controls: 'Recommended: ALTER ROLE … NOLOGIN (or PASSWORD NULL) for all three after cut-over — changes the posture golden and workerRoleProblems. NEEDS OWNER APPROVAL.',
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
]);

/** The five protections the addendum names as NOT accepted in §2 (+ BC-17 found here): each must stay needs-owner-approval. */
export const NEEDS_OWNER_APPROVAL_IDS: readonly string[] = OWNER_LOGIN_BEHAVIOUR_CATALOGUE.filter((e) => e.status === 'needs-owner-approval').map((e) => e.id);
