/**
 * T7 (Agent 5): shared kit for the Twenty Mode Option A suites (behaviour catalogue C1–C8, injection simulation R5,
 * refusals and negative controls). Disposable loopback databases only.
 *
 * GATED: runs only when TWENTY_MODE_TESTS=true AND TEST_DATABASE_TWENTY_OWNER_URL is set (twenty-test-env.cjs emits both,
 * plus TEST_DATABASE_URL = the owner URL, because under Option A the API's login IS crewflow_owner). Otherwise every suite
 * skips — and a CI job that claims to run them must prove they did (the E5 lesson; see twenty-suite-check in the workflow).
 *
 * OWNER DECISION (2026-11-04, PERMANENT-OWNER-LOGIN-ADDENDUM): there is ONE architecture, the permanent owner login
 * `crewflow_owner` (no mode switch). This catalogue is the reviewed BEHAVIOUR-CHANGE CATALOGUE: every protection the
 * restricted runtime logins gave and the owner login cannot keep is a test here with a severity, labelled either
 * OWNER-ACCEPTED (listed in the owner's final prompt §2) or NEEDS OWNER APPROVAL (not listed there) — see ACCEPTED/APPROVAL.
 *
 * SECURITY SEMANTICS. A test here never turns a known Option A risk into a "PASS of a security property":
 *   - `expectedRisk(...)`  a VERIFIED, known consequence of Option A (G-xx / D-x in docs/TWENTY_MODE_M0_DECISION_2026-11-04.md).
 *                          The test asserts the risk is really present (so a silent change is caught) and RECORDS a finding;
 *                          it is reported as EXPECTED-RISK, never as a passed control. Owner acceptance is a separate field.
 *   - `controlHolds(...)`  a security property that really holds under Option A (a hard floor, FORCE isolation, …).
 * Findings go to TWENTY_FINDINGS_FILE (JSON lines) when set, and to stdout as `[twenty-finding] {...}`.
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { integrationTestDatabase } from '../../../database/typeorm/core/integration-test-database-gate';

export const OWNER_URL = process.env.TEST_DATABASE_TWENTY_OWNER_URL;
export const ADMIN_URL = integrationTestDatabase().adminUrl;
/** Only on a database built by the separated M2 harness (pre-T2 fixture): the restricted runtime login, for negative controls. */
export const SEPARATED_APP_URL = process.env.TEST_DATABASE_SEPARATED_APP_URL;
export const TWENTY_RUN = process.env.TWENTY_MODE_TESTS === 'true' && Boolean(OWNER_URL && ADMIN_URL);
export const describeTwenty = TWENTY_RUN ? describe : describe.skip;
/** `fixture` = pre-T2 owner-fixture on a separated-built chain; `bootstrap` = a TW-I1 database built by twenty-migrate. */
export const TWENTY_DB_SOURCE = process.env.TWENTY_DB_SOURCE === 'bootstrap' ? 'bootstrap' : 'fixture';

export type FindingKind = 'EXPECTED-RISK' | 'CONTROL-HOLDS' | 'HARD-FLOOR' | 'REGRESSION';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  /** actor → action → consequence (THREAT-MODEL §5.8 shape) */
  statement: string;
  evidence: string;
  /** Who accepted it, or what acceptance it still needs. Never implied by a passing test. */
  acceptance?: string;
  source: typeof TWENTY_DB_SOURCE;
}

export function record(f: Omit<Finding, 'source'>): void {
  const full: Finding = { ...f, source: TWENTY_DB_SOURCE };
  const line = JSON.stringify(full);
  if (process.env.TWENTY_FINDINGS_FILE) appendFileSync(process.env.TWENTY_FINDINGS_FILE, `${line}\n`);
  // eslint-disable-next-line no-console
  console.log(`[twenty-finding] ${line}`);
}

/** The owner's final prompt §2: consequences explicitly accepted. */
export const ACCEPTED = {
  crossOrgAuthData: 'OWNER-ACCEPTED (§2: cross-organisation authentication data)',
  injection: 'OWNER-ACCEPTED (§2: SQL injection with owner privileges)',
  takeoverMfa: 'OWNER-ACCEPTED (§2: account takeover and MFA bypass)',
  policyModification: 'OWNER-ACCEPTED (§2: policy modification)',
  objectDeletion: 'OWNER-ACCEPTED (§2: object deletion)',
  auditTampering: 'OWNER-ACCEPTED (§2: audit tampering)',
  persistence: 'OWNER-ACCEPTED (§2: persistence through roles or definers)',
  credentialExposure: 'OWNER-ACCEPTED (§2: credential-exposure impact)',
} as const;
/** NOT in §2: each needs explicit owner approval before the final removal PR (#9). */
export const APPROVAL = {
  dba01: 'NEEDS OWNER APPROVAL (not in §2: loss of DBA-01 API/Worker separation)',
  deploymentIdentity: 'NEEDS OWNER APPROVAL (not in §2: deployment identity rebindable by the runtime)',
  logicalBackup: 'NEEDS OWNER APPROVAL (not in §2: no logical backup by the app login, PITR only)',
  columnGrants: 'NEEDS OWNER APPROVAL (not in §2: loss of column-level secret grants)',
  dueWorkPointers: 'NEEDS OWNER APPROVAL (not in §2: worker_due_work and pointer direct access)',
} as const;

export const expectedRisk = (id: string, severity: Severity, statement: string, evidence: string, acceptance: string) =>
  record({ id, kind: 'EXPECTED-RISK', severity, statement, evidence, acceptance });
export const controlHolds = (id: string, statement: string, evidence: string) => record({ id, kind: 'CONTROL-HOLDS', severity: 'INFO', statement, evidence });
export const hardFloor = (id: string, statement: string, evidence: string) => record({ id, kind: 'HARD-FLOOR', severity: 'INFO', statement, evidence });

export async function connect(url: string, applicationName = 'twenty-t7'): Promise<Client> {
  const c = new Client({ connectionString: url, application_name: applicationName });
  await c.connect();
  return c;
}

/** SQLSTATE of a statement, or 'OK' (with the rows) when it succeeded. */
export async function attempt(c: Client, sql: string, params: unknown[] = []): Promise<{ state: string; rows: Array<Record<string, unknown>>; message?: string }> {
  try {
    const r = await c.query(sql, params);
    return { state: 'OK', rows: r.rows };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { state: err.code ?? 'ERROR', rows: [], message: err.message };
  }
}

/** Runs fn inside BEGIN … ROLLBACK on `c` (the injection simulation never leaves anything behind). */
export async function rolledBack<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    return await fn();
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    // A session-level SET ROLE / set_config(...,false) survives ROLLBACK only if issued outside the transaction; reset anyway.
    await c.query('RESET ROLE').catch(() => undefined);
    await c.query('RESET ALL').catch(() => undefined);
  }
}

export interface TwoTenants {
  orgA: string;
  orgB: string;
  userA: string;
  userB: string;
  workspaceA: string;
  workspaceB: string;
  marker: string;
}

/** Two organisations with one user, one session and one audit row each, written by the fixture superuser (bypasses RLS). */
export async function seedTwoTenants(admin: Client): Promise<TwoTenants> {
  const marker = `twa${randomUUID().slice(0, 8)}`;
  const [orgA, orgB, userA, userB, workspaceA, workspaceB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const [org, user, ws, tag] of [
    [orgA, userA, workspaceA, 'a'],
    [orgB, userB, workspaceB, 'b'],
  ]) {
    await admin.query(`INSERT INTO core.organisation (id, name, slug) VALUES ($1, $2, $3)`, [org, `${marker} org ${tag}`, `${marker}-${tag}`]);
    await admin.query(
      `INSERT INTO core."user" (id, organisation_id, email, first_name, last_name, password_hash)
       VALUES ($1, $2, $3, 'T7', $4, $5)`,
      [user, org, `${marker}-${tag}@example.test`, marker, `$argon2id$v=19$m=19456,t=2,p=1$${marker}${tag}$fixture-not-a-real-hash`],
    );
    await admin.query(
      `INSERT INTO core.user_session (id, organisation_id, user_id, application_target, absolute_expires_at)
       VALUES ($1, $2, $3, 'manager_web', now() + interval '1 day')`,
      [randomUUID(), org, user],
    );
    await admin.query(`INSERT INTO core.audit_log (organisation_id, action) VALUES ($1, $2)`, [org, `${marker}.fixture`]);
    await admin.query(`INSERT INTO core.manager_workspace (id, organisation_id, owner_user_id, name, subdomain) VALUES ($1, $2, $3, $4, $5)`, [
      ws, org, user, `${marker} ws ${tag}`, `${marker}-${tag}`,
    ]);
    await admin.query(
      `INSERT INTO core.worker_due_work (organisation_id, workspace_id, job_type, subject_type, subject_id, due_at, status)
       VALUES ($1, $2, 'manager_confirmation_timeout', 'job_offer', $3, now() + interval '1 day', 'PENDING')`,
      [org, ws, randomUUID()],
    );
  }
  return { orgA, orgB, userA, userB, workspaceA, workspaceB, marker };
}

/** Binds a tenant the way TenantContextService does (transaction-local GUC). */
export async function bindOrg(c: Client, org: string): Promise<void> {
  await c.query(`SELECT set_config('rab.organisation_id', $1, true)`, [org]);
}

/** The 16 pre-auth tables that are RLS-enabled but NOT FORCE (read live; M0-B/M0-H counted 16, CLAUDE.md says 15). */
export const NOT_FORCE_SQL = `
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'core' AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity ORDER BY 1`;

export const PRE_AUTH_TABLES = [
  'account_invite', 'email_change_request', 'login_handoff', 'login_history', 'manager_workspace', 'member_invitation',
  'organisation', 'organisation_invitation', 'password_reset_token', 'platform_admin', 'refresh_token', 'released_host_label',
  'user', 'user_auth_identity', 'user_session', 'worker_due_work',
] as const;
