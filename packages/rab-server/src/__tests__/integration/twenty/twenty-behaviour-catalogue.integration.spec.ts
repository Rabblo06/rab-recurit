/**
 * T7 R4 — the Option A behaviour catalogue C1–C8, on a REAL chain database, as the single login `crewflow_owner`.
 * Every case asserts the observed database behaviour; known Option A consequences are recorded as EXPECTED-RISK findings
 * (never as passed controls), real controls as CONTROL-HOLDS. Gated: see twenty-kit.ts.
 *
 *   C1 pre-auth tables (G-01)        C2 column grants (G-01/G-03)   C3 audit_log append-only (G-05)
 *   C4 current_user rules (MFA guard, owner-only definer policies; G-03)
 *   C5 Worker-only claim functions (G-08, DBA-01)                   C6 deployment marker (G-06)
 *   C7 provisioning registry guard (G-10, M-T2)                     C8 pg_terminate_backend between sessions (G-08)
 *   C9 worker_due_work direct cross-tenant access (G-08/D0-A1)      C10 logical backup by the app login (G-11)
 * Each restricted-login protection the owner login loses is labelled OWNER-ACCEPTED (§2) or NEEDS OWNER APPROVAL.
 */
import { Client } from 'pg';

import {
  ACCEPTED,
  ADMIN_URL,
  APPROVAL,
  attempt,
  bindOrg,
  connect,
  controlHolds,
  describeTwenty,
  expectedRisk,
  hardFloor,
  NOT_FORCE_SQL,
  OWNER_URL,
  PRE_AUTH_TABLES,
  rolledBack,
  seedTwoTenants,
  SEPARATED_APP_URL,
  TwoTenants,
} from './twenty-kit';

jest.setTimeout(120_000);

describeTwenty('Twenty Option A behaviour catalogue C1–C8 (crewflow_owner, real chain)', () => {
  let admin: Client;
  let owner: Client;
  let app: Client | null = null;
  let t: TwoTenants;
  let m_t1: boolean;

  beforeAll(async () => {
    admin = await connect(ADMIN_URL!, 'twenty-t7-admin');
    owner = await connect(OWNER_URL!, 'twenty-t7-owner');
    if (SEPARATED_APP_URL) app = await connect(SEPARATED_APP_URL, 'twenty-t7-app');
    const who = (await owner.query(`SELECT session_user AS s, current_user AS c, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = session_user`)).rows[0];
    // The suite is meaningless as any other login: refuse rather than report.
    if (who.s !== 'crewflow_owner' || who.c !== 'crewflow_owner' || who.rolsuper || who.rolbypassrls) {
      throw new Error('TEST_DATABASE_TWENTY_OWNER_URL is not the non-superuser, non-BYPASSRLS crewflow_owner login. Refusing.');
    }
    t = await seedTwoTenants(admin);
    const notForce = (await admin.query(NOT_FORCE_SQL)).rows.map((r) => String(r.relname));
    m_t1 = notForce.length === 0;
    if (!m_t1) expect(notForce).toEqual([...PRE_AUTH_TABLES]);
  });

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await admin?.end();
  });

  it('C0: before M-T1 exactly the 16 pre-auth tables are NOT FORCE; after M-T1 (1786721400000) all 16 FORCE with the exact owner-only definer policy', async () => {
    const notForce = (await admin.query(NOT_FORCE_SQL)).rows.map((r) => String(r.relname));
    if (m_t1) {
      expect(notForce).toEqual([]);
      // M-T1's contract (Agent 3, PreAuthTablesForceOwnerOnly1786721400000): per table ENABLE + FORCE and one policy
      // <table>_secure_owner_definer, PERMISSIVE, FOR ALL, TO rab_secure_owner, USING and WITH CHECK (CURRENT_USER = 'rab_secure_owner').
      const rows = (
        await admin.query(
          `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                  (SELECT count(*)::int FROM pg_policy p
                    WHERE p.polrelid = c.oid AND p.polname = c.relname || '_secure_owner_definer' AND p.polpermissive AND p.polcmd = '*'
                      AND p.polroles = ARRAY['rab_secure_owner'::regrole::oid]
                      AND pg_get_expr(p.polqual, p.polrelid) = '(CURRENT_USER = ''rab_secure_owner''::name)'
                      AND pg_get_expr(p.polwithcheck, p.polrelid) = '(CURRENT_USER = ''rab_secure_owner''::name)') AS definer_policies
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'core' AND c.relname = ANY($1::text[]) ORDER BY 1`,
          [[...PRE_AUTH_TABLES]],
        )
      ).rows;
      expect(rows.map((r) => r.relname)).toEqual([...PRE_AUTH_TABLES]);
      const bad = rows.filter((r) => !r.enabled || !r.forced || r.definer_policies !== 1).map((r) => r.relname);
      expect(bad).toEqual([]);
      controlHolds('C0/M-T1', 'all 16 pre-auth tables ENABLE + FORCE with the exact owner-only definer policy (normal code paths only)', `16/16; bad: ${bad.join(',') || 'none'}`);
    } else {
      expect(notForce).toHaveLength(16);
      expect(notForce).toContain('organisation_invitation');
      expectedRisk('DOC-16', 'LOW', 'CLAUDE.md → lists 15 NOT FORCE tables → organisation_invitation is undocumented', `live NOT FORCE set (${notForce.length}): ${notForce.join(',')}`, 'doc fix (CLAUDE.md is owned by Agent 3, security)');
    }
  });

  it('C1 pre-auth: with NO tenant context, the owner login reads both tenants\' users and sessions (G-01) — or 0 rows after M-T1', async () => {
    const users = await owner.query(`SELECT organisation_id FROM core."user" WHERE last_name = $1`, [t.marker]);
    const sessions = await owner.query(`SELECT organisation_id FROM core.user_session WHERE organisation_id = ANY($1::uuid[])`, [[t.orgA, t.orgB]]);
    if (m_t1) {
      expect(users.rowCount).toBe(0);
      expect(sessions.rowCount).toBe(0);
      controlHolds('C1/M-T1', 'owner login direct read of pre-auth tables returns 0 rows without tenant context (normal code paths only)', `users=0 sessions=0`);
      return;
    }
    expect(new Set(users.rows.map((r) => r.organisation_id))).toEqual(new Set([t.orgA, t.orgB]));
    expect(sessions.rowCount).toBe(2);
    expectedRisk(
      'G-01', 'CRITICAL',
      'any code path of the API/Worker login → a query on a pre-auth table with a missing tenant filter (no injection) → reads every tenant\'s rows',
      `no tenant context: core."user" rows from ${new Set(users.rows.map((r) => r.organisation_id)).size} orgs, user_session rows ${sessions.rowCount}`,
      ACCEPTED.crossOrgAuthData,
    );
    if (app) {
      // Negative control: the separated runtime login on the same database is bound by the policy.
      const appUsers = await app.query(`SELECT 1 FROM core."user" WHERE last_name = $1`, [t.marker]);
      expect(appUsers.rowCount).toBe(0);
      controlHolds('C1/separated', 'crewflow_app (separated mode) reads 0 pre-auth rows without tenant context on the same database', 'rows=0');
    }
  });

  it('C1b: FORCE tenant tables still isolate the owner login on normal paths (control) — tenant B invisible with A bound', async () => {
    await owner.query('BEGIN');
    try {
      await bindOrg(owner, t.orgA);
      const rows = (await owner.query(`SELECT organisation_id FROM core.audit_log WHERE action = $1`, [`${t.marker}.fixture`])).rows;
      expect(rows.map((r) => r.organisation_id)).toEqual([t.orgA]);
      const noCtx = await owner.query(`SELECT set_config('rab.organisation_id', '', true)`).then(() => owner.query(`SELECT 1 FROM core.audit_log WHERE action = $1`, [`${t.marker}.fixture`]));
      expect(noCtx.rowCount).toBe(0);
    } finally {
      await owner.query('ROLLBACK');
    }
    controlHolds('C1b', 'FORCE tenant tables bind the owner login: org A context sees only org A, no context sees 0 rows', 'audit_log: [orgA] / 0');
  });

  it('C2 column grants: the owner login reads password_hash / totp_secret_encrypted of every tenant (G-01, G-03)', async () => {
    const secret = await attempt(owner, `SELECT password_hash, totp_secret_encrypted, temporary_password_hash, totp_last_used_step FROM core."user" WHERE last_name = $1`, [t.marker]);
    expect(secret.state).toBe('OK');
    expect(secret.rows).toHaveLength(m_t1 ? 0 : 2);
    if (!m_t1) expect(secret.rows.every((r) => typeof r.password_hash === 'string' && String(r.password_hash).startsWith('$argon2id$'))).toBe(true);
    expectedRisk(
      'G-01/C2', 'CRITICAL',
      'API/Worker login → SELECT on core."user" → column grants do not bind the owner: password hashes, TOTP ciphertext, temporary password hashes of every tenant',
      `columns readable; rows returned without context: ${secret.rows.length}${m_t1 ? ' (M-T1: 0 rows on normal paths, columns still readable after SET ROLE)' : ''}`,
      APPROVAL.columnGrants,
    );
    if (app) {
      const denied = await attempt(app, `SELECT password_hash FROM core."user" LIMIT 1`);
      expect(denied.state).toBe('42501');
      controlHolds('C2/separated', 'crewflow_app cannot read core."user".password_hash (column grant)', 'SQLSTATE 42501');
    }
  });

  it('C3 audit_log: direct UPDATE/DELETE/TRUNCATE are refused even to the owner login (control); a self-grant defeats it (G-05)', async () => {
    const directStates: string[] = [];
    for (const sql of [
      `UPDATE core.audit_log SET action = action WHERE action = '${t.marker}.fixture'`,
      `DELETE FROM core.audit_log WHERE action = '${t.marker}.fixture'`,
      'TRUNCATE core.audit_log',
    ]) {
      directStates.push(
        await rolledBack(owner, async () => {
          await bindOrg(owner, t.orgA);
          return (await attempt(owner, sql)).state;
        }),
      );
    }
    expect(directStates).toEqual(['42501', '42501', '42501']);
    controlHolds('C3/acl', "audit_log UPDATE/DELETE/TRUNCATE are not in the table owner's own ACL: the owner login is refused on every normal path", `UPDATE/DELETE/TRUNCATE: ${directStates.join('/')}`);

    const viaGrant = await rolledBack(owner, async () => {
      const grant = await attempt(owner, 'GRANT UPDATE, DELETE, TRUNCATE ON core.audit_log TO crewflow_owner');
      await bindOrg(owner, t.orgA);
      const upd = await attempt(owner, `UPDATE core.audit_log SET action = action || '.tampered' WHERE action = $1 RETURNING organisation_id`, [`${t.marker}.fixture`]);
      const trunc = await attempt(owner, 'TRUNCATE core.audit_log');
      return { grant: grant.state, upd: upd.state, updRows: upd.rows.length, trunc: trunc.state };
    });
    expect(viaGrant).toEqual({ grant: 'OK', upd: 'OK', updRows: 1, trunc: 'OK' });
    const left = await admin.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = $1`, [`${t.marker}.fixture`]);
    expect(left.rows[0].n).toBe(2); // rolled back: the evidence rows are intact
    expectedRisk(
      'G-05', 'HIGH',
      'injection as the owner login → GRANT UPDATE/DELETE/TRUNCATE on core.audit_log to itself → rewrites or erases the audit trail of every tenant (TRUNCATE ignores RLS)',
      `self-grant ${viaGrant.grant}; UPDATE ${viaGrant.upd} (${viaGrant.updRows} row); TRUNCATE ${viaGrant.trunc}; all rolled back`,
      `${ACCEPTED.auditTampering}; mandatory control: external append-only audit sink (M0 §3.4)`,
    );
    if (app) {
      const appUpd = await rolledBack(app, async () => {
        await bindOrg(app!, t.orgA);
        return attempt(app!, `UPDATE core.audit_log SET action = action WHERE action = $1`, [`${t.marker}.fixture`]);
      });
      expect(appUpd.state).toBe('42501');
      controlHolds('C3/separated', 'crewflow_app cannot UPDATE audit_log (REVOKE holds for the restricted login)', 'SQLSTATE 42501');
    }
  });

  it('C4 current_user rules: the MFA column guard refuses the owner login directly (control), but SET ROLE or DISABLE TRIGGER defeats it (G-03)', async () => {
    const direct = await rolledBack(owner, () =>
      attempt(owner, `UPDATE core."user" SET totp_last_used_step = 42 WHERE id = $1 RETURNING id`, [t.userB]),
    );
    if (m_t1) {
      // M-T1: the row is invisible on a normal path, so the update matches nothing.
      expect(['OK']).toContain(direct.state);
      expect(direct.rows).toHaveLength(0);
    } else {
      expect(direct.state).toBe('42501');
      expect(direct.message).toMatch(/user_mfa_columns_guard/);
    }
    controlHolds('C4/mfa-guard', 'the MFA column guard (current_user rule) refuses a direct MFA-column write by the owner login on a normal path', `direct: ${direct.state}`);

    const viaSetRole = await rolledBack(owner, async () => {
      await owner.query('SET LOCAL ROLE rab_secure_owner');
      return attempt(owner, `UPDATE core."user" SET totp_last_used_step = 42 WHERE id = $1 RETURNING id`, [t.userB]);
    });
    expect(viaSetRole.state).toBe('OK');
    expect(viaSetRole.rows).toHaveLength(1);
    const viaDisable = await rolledBack(owner, () => attempt(owner, `ALTER TABLE core."user" DISABLE TRIGGER user_mfa_columns_guard`));
    expect(viaDisable.state).toBe('OK');
    const stillEnabled = await admin.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'user_mfa_columns_guard'`);
    expect(stillEnabled.rows[0].tgenabled).toBe('O');
    expectedRisk(
      'G-03', 'CRITICAL',
      'injection as the owner login → SET ROLE rab_secure_owner (or DISABLE TRIGGER) → writes another tenant\'s MFA columns: cross-tenant account takeover with MFA bypass',
      `SET LOCAL ROLE + UPDATE other tenant: ${viaSetRole.state} (${viaSetRole.rows.length} row); DISABLE TRIGGER: ${viaDisable.state}; all rolled back`,
      ACCEPTED.takeoverMfa,
    );
  });

  it('C4b owner-only definer policies: the owner login reads 0 rows of worker_dispatch_pointer / deployment_identity directly; SET ROLE reads them', async () => {
    const seededPointerRows = Number((await admin.query(`SELECT count(*)::int AS n FROM core.worker_dispatch_pointer`)).rows[0].n);
    const seededMarker = Number((await admin.query(`SELECT count(*)::int AS n FROM core.deployment_identity`)).rows[0].n);
    const direct = await owner.query(`SELECT (SELECT count(*) FROM core.worker_dispatch_pointer)::int AS p, (SELECT count(*) FROM core.deployment_identity)::int AS d`);
    expect(direct.rows[0]).toEqual({ p: 0, d: 0 });
    const escalated = await rolledBack(owner, async () => {
      await owner.query('SET LOCAL ROLE rab_secure_owner');
      return (await owner.query(`SELECT (SELECT count(*) FROM core.worker_dispatch_pointer)::int AS p, (SELECT count(*) FROM core.deployment_identity)::int AS d`)).rows[0];
    });
    expect(escalated).toEqual({ p: seededPointerRows, d: seededMarker });
    controlHolds('C4b', 'CURRENT_USER-pinned definer policies hide dispatch pointers and the deployment marker from the owner login on normal paths', `direct p=0 d=0 (superuser sees p=${seededPointerRows} d=${seededMarker})`);
    expectedRisk('G-09/C4b', 'MEDIUM', 'injection → SET ROLE rab_secure_owner → reads/writes owner-only tables (dispatch pointers, deployment marker)', `after SET LOCAL ROLE: p=${escalated.p} d=${escalated.d}`, `${ACCEPTED.injection}; ${APPROVAL.dueWorkPointers}`);
  });

  it('C5 Worker-only claim functions are executable by the API\'s login (G-08: DBA-01 separation lost)', async () => {
    const fns = (
      await admin.query(
        `SELECT p.oid::regprocedure::text AS f, has_function_privilege('crewflow_owner', p.oid, 'EXECUTE') AS owner_x,
                has_function_privilege('crewflow_app', p.oid, 'EXECUTE') AS app_x
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'core' AND has_function_privilege('crewflow_worker', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('crewflow_app', p.oid, 'EXECUTE') ORDER BY 1`,
      )
    ).rows;
    expect(fns.map((r) => r.f)).toEqual(
      expect.arrayContaining(['core.worker_claim_email_dispatch(integer)', 'core.worker_release_dispatch_claim(text,uuid,uuid,integer)', 'core.worker_delete_expired_invited_user(uuid)']),
    );
    expect(fns.every((r) => r.owner_x === true)).toBe(true);
    // Real execution (rolled back): the API's own login claims Worker dispatch work.
    const claim = await rolledBack(owner, () => attempt(owner, `SELECT * FROM core.worker_claim_email_dispatch(1)`));
    expect(claim.state).toBe('OK');
    const due = (
      await admin.query(
        `SELECT bool_and(has_function_privilege('crewflow_owner', f::regprocedure, 'EXECUTE')) AS ok
           FROM unnest(ARRAY['core.worker_claim_due_work(text, integer, integer)','core.worker_complete_due_work(uuid, uuid)',
                             'core.worker_reschedule_due_work(uuid, uuid, timestamp with time zone)']) f`,
      )
    ).rows[0];
    expect(due.ok).toBe(true);
    expectedRisk(
      'G-08', 'MEDIUM',
      'API process (same login as the Worker) → executes worker_claim_* / worker_release_dispatch_claim / invite-cleanup definers / due-work functions → API can claim, release and delete Worker work; a Worker RCE holds the owner credential',
      `${fns.length} crewflow_worker-only functions all EXECUTE-able by crewflow_owner; email claim executed: ${claim.state}; due-work 3/3`,
      APPROVAL.dba01,
    );
    if (app) {
      const appClaim = await rolledBack(app, () => attempt(app!, `SELECT * FROM core.worker_claim_email_dispatch(1)`));
      expect(appClaim.state).toBe('42501');
      controlHolds('C5/separated', 'crewflow_app cannot execute Worker-only claim functions (separated DBA-01 holds)', 'SQLSTATE 42501');
    }
  });

  it('C6 deployment marker: the owner login passes deployment_identity_bind\'s EXECUTE and session-membership gate (G-06)', async () => {
    const r = (
      await owner.query(
        `SELECT has_function_privilege('core.deployment_identity_bind(text,uuid,text,text,uuid,text[])', 'EXECUTE') AS x,
                pg_has_role(session_user, 'rab_secure_owner', 'MEMBER') AS member,
                session_user NOT IN ('crewflow', 'crewflow_app') AS not_runtime_name`,
      )
    ).rows[0];
    expect(r).toEqual({ x: true, member: true, not_runtime_name: true });
    expectedRisk(
      'G-06', 'HIGH',
      'API/Worker login → core.deployment_identity_bind (or SET ROLE + direct write) → re-binds the deployment identity: the N1 production approval is effectively removed',
      'EXECUTE=true, session login is a rab_secure_owner MEMBER and not crewflow/crewflow_app (the definer\'s own gate admits it)',
      `${APPROVAL.deploymentIdentity}; mitigation D6 (id mandatory after first bind, bind only on an empty database)`,
    );
  });

  it('C7 provisioning: the registry versioning guard is a deny-list that admits the owner login (G-10) — allow-list after M-T2', async () => {
    const body = String((await admin.query(`SELECT prosrc FROM pg_proc WHERE proname = 'workspace_schema_registry_versioning_guard'`)).rows[0].prosrc);
    const denyList = /IF\s+current_user\s*<>\s*'crewflow_app'\s+THEN\s+RETURN\s+NEW/i.test(body);
    if (denyList) {
      expectedRisk(
        'G-10', 'MEDIUM',
        'API/Worker login → writes workspace_schema_registry versioning/drift columns → the guard only refuses crewflow_app, so the owner login can mark a drifted workspace clean',
        'guard body: IF current_user <> \'crewflow_app\' THEN RETURN NEW (deny-list; M-T2 not applied)',
        'M-T2 approved by owner (allow-list); NOT YET LANDED',
      );
    } else {
      expect(body).not.toMatch(/crewflow_owner/);
      controlHolds('C7/M-T2', 'registry guard is an allow-list that does not admit crewflow_owner', 'M-T2 body present');
    }
    expect(typeof denyList).toBe('boolean');
  });

  it('C8 pg_terminate_backend: one owner session can terminate another (API kills Worker sessions); a superuser backend cannot be signalled', async () => {
    const victim = await connect(OWNER_URL!, 'twenty-t7-victim');
    const victimPid = (await victim.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
    victim.on('error', () => undefined);
    const killed = await attempt(owner, `SELECT pg_terminate_backend($1) AS ok`, [victimPid]);
    expect(killed.state).toBe('OK');
    expect(killed.rows[0].ok).toBe(true);
    await victim.end().catch(() => undefined);
    const adminPid = (await admin.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
    const refused = await attempt(owner, `SELECT pg_terminate_backend($1) AS ok`, [adminPid]);
    expect(refused.state).toBe('42501');
    expect((await admin.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
    expectedRisk('G-08/C8', 'LOW', 'API process → pg_terminate_backend on the Worker\'s sessions (same login) → availability, no data access', `owner→owner: terminated=${killed.rows[0].ok}`, APPROVAL.dba01);
    hardFloor('C8/superuser', 'the owner login cannot signal a superuser backend', `SQLSTATE ${refused.state}`);
  });

  it("C9 worker_due_work: the owner login reads, re-schedules and deletes every tenant's timer pointers directly, no definer needed", async () => {
    const seen = await owner.query(`SELECT organisation_id FROM core.worker_due_work WHERE workspace_id = ANY($1::uuid[])`, [[t.workspaceA, t.workspaceB]]);
    const writes = await rolledBack(owner, async () => {
      const upd = await attempt(owner, `UPDATE core.worker_due_work SET due_at = now() WHERE workspace_id = ANY($1::uuid[])`, [[t.workspaceA, t.workspaceB]]);
      const del = await attempt(owner, `DELETE FROM core.worker_due_work WHERE workspace_id = $1 RETURNING id`, [t.workspaceB]);
      return { upd: upd.state, del: del.state, delRows: del.rows.length };
    });
    if (m_t1) {
      expect(seen.rowCount).toBe(0);
      controlHolds('C9/M-T1', 'worker_due_work hidden from the owner login on normal paths (M-T1)', 'rows=0');
      return;
    }
    expect(new Set(seen.rows.map((r) => r.organisation_id))).toEqual(new Set([t.orgA, t.orgB]));
    expect(writes).toEqual({ upd: 'OK', del: 'OK', delRows: 1 });
    expectedRisk(
      'D0-A1/C9', 'MEDIUM',
      "API/Worker login (no injection) → direct SELECT/UPDATE/DELETE on core.worker_due_work (NOT FORCE, owned by a role it inherits) → reads, delays or drops any tenant's offer/AI timers",
      `no context: rows from ${new Set(seen.rows.map((r) => r.organisation_id)).size} orgs; UPDATE ${writes.upd}; DELETE other tenant ${writes.del} (${writes.delRows}); rolled back`,
      APPROVAL.dueWorkPointers,
    );
    if (app) {
      const appSeen = await app.query(`SELECT 1 FROM core.worker_due_work WHERE workspace_id = ANY($1::uuid[])`, [[t.workspaceA, t.workspaceB]]);
      expect(appSeen.rowCount).toBe(0);
      controlHolds('C9/separated', 'crewflow_app sees 0 due-work rows without tenant context', 'rows=0');
    }
  });

  it('C10 logical backup: as the app login, a FORCE tenant table dumps EMPTY (no tenant context); PITR is the only full backup', async () => {
    const real = Number((await admin.query(`SELECT count(*)::int AS n FROM core.audit_log`)).rows[0].n);
    const asOwner = Number((await owner.query(`SELECT count(*)::int AS n FROM core.audit_log`)).rows[0].n);
    expect(real).toBeGreaterThanOrEqual(2);
    expect(asOwner).toBe(0);
    expectedRisk(
      'G-11', 'MEDIUM',
      "operator → pg_dump with the only credential the deployment holds (crewflow_owner) → every FORCE tenant table dumps empty → no usable logical backup; a post-compromise PITR point carries the attacker's roles/definers",
      `audit_log rows: superuser ${real}, owner login without context ${asOwner}`,
      APPROVAL.logicalBackup,
    );
  });
});
