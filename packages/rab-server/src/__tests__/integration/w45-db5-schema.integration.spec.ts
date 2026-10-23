import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { EXPECTED_WORKSPACE_FINGERPRINTS } from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../../database/typeorm/workspace-schema/workspace-schema-modules';
import { pgClientRunner, WorkspaceSchemaMigrator } from '../../database/typeorm/workspace-schema/workspace-schema-migrator';
import { dropWorkspaceSchema, ledgerOf, provisionLegacyV14, provisionServerPath, registryOf, SeededWorkspace, seedWorkspace, sqlstateOf } from './helpers/workspace-fixtures';

/**
 * Waves 4+5 lane DB5 (schema owner): abuse-case and no-context tests for every object in docs/evidence/w45-db5/CONTRACT.md,
 * against the real functions on a disposable database built from migrations alone (bootstrap superuser as
 * TEST_DATABASE_URL_UNPOOLED, crewflow_app as TEST_DATABASE_URL).
 *
 *  §1 MFA: guard trigger (runtime role cannot write/rewind MFA state), atomic replay protection incl. a real concurrent race,
 *     recovery codes single-use + never readable, cross-tenant / no-context refusals, envelope CHECK on the secret.
 *  §2 Login handoff: single use (incl. concurrent consume), ≤ 60 s, audience-bound, invalidated by session revoke /
 *     security_version / rename / suspension, no table privilege, policy returns zero rows with no context.
 *  §3 Archive: pair + draft-only CHECKs, restore never conflicts, never on money/attendance/audit tables, core + workspace.
 *  §4 Search: accent-insensitive FTS + trigram, GIN usable, cross-tenant 0, email never matches.
 *  §5 Outbox: no direct DELETE, purge terminal-only + per tenant + floors, replay semantics + audit.
 *  §6 Timeline index, §7 envelope CHECKs, §8 field-permission object keys.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(240_000);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hex64 = () => randomBytes(32).toString('hex');
/** A syntactically valid RAB2 envelope (MAGIC || kidLen || kid || iv(12) || tag(16) || ct). Content is never decrypted here. */
const rab2 = (kid = 'k1', ct = 8) => Buffer.concat([Buffer.from('RAB2'), Buffer.from([Buffer.byteLength(kid)]), Buffer.from(kid), randomBytes(12 + 16 + ct)]);
const nowStep = () => Math.floor(Date.now() / 1000 / 30);
/** SQLSTATE of one statement run inside the caller's open transaction, isolated by a savepoint (the txn stays usable). */
const spq = async (c: Client, sql: string, params?: unknown[]): Promise<string> => {
  await c.query('SAVEPOINT db5_probe');
  const code = await sqlstateOf(c.query(sql, params));
  await c.query('ROLLBACK TO SAVEPOINT db5_probe');
  return code;
};

describeIfDb('waves 4+5 lane DB5 schema contract', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  const sfx = Math.random().toString(36).slice(2, 8);
  let admin: Client;
  const workspaces: SeededWorkspace[] = [];
  const clients: Client[] = [];

  const app = async (): Promise<Client> => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    clients.push(c);
    return c;
  };
  /** Runs fn in a crewflow_app transaction with the given server-bound GUCs, then COMMITs (or ROLLBACKs on throw). */
  const asApp = async <T>(ctx: { org?: string; ws?: string; uid?: string }, fn: (c: Client) => Promise<T>, commit = true): Promise<T> => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`,
        [ctx.org ?? '', ctx.ws ?? '', ctx.uid ?? ''],
      );
      const out = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end().catch(() => undefined); // one short-lived connection per call (the suite opens hundreds)
    }
  };
  const newOrgUser = async (tag: string) => {
    const r = await admin.query(
      `WITH o AS (INSERT INTO core.organisation(name, slug) VALUES ($1::text, $1::text) RETURNING id)
       INSERT INTO core."user"(organisation_id, email, first_name, last_name, status)
       SELECT id, $1::text || '@db5.invalid', 'Db5', 'User', 'active' FROM o RETURNING id, organisation_id`,
      [`db5-${tag}-${sfx}`],
    );
    return { user: r.rows[0].id as string, org: r.rows[0].organisation_id as string };
  };
  const readyWorkspace = async (tag: string) => {
    const ws = await seedWorkspace(admin, `db5${tag}-${sfx}`);
    workspaces.push(ws);
    expect(await provisionServerPath(appUrl, ws)).toBe('READY');
    return ws;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    if (!(await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper) {
      throw new Error('this suite needs the disposable database bootstrap superuser as TEST_DATABASE_URL_UNPOOLED');
    }
  });

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    // Leave no fake (undecryptable) TOTP secrets behind for suites that scan every encrypted value (secret:rotate).
    await admin.query(
      `UPDATE core."user" SET totp_enabled = false, totp_secret_encrypted = NULL, totp_last_used_step = NULL, mfa_enabled_at = NULL
        WHERE organisation_id IN (SELECT organisation_id FROM core."user" WHERE email LIKE '%' || $1 || '%')
          AND (totp_enabled OR totp_secret_encrypted IS NOT NULL)`,
      [sfx],
    ).catch(() => undefined);
    for (const ws of workspaces) await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
    // Leave the registry rows non-READY so later migrator runs on this disposable DB skip the dropped schemas.
    for (const ws of workspaces) await admin.query(`UPDATE core.workspace_schema_registry SET status = 'FAILED' WHERE workspace_id = $1`, [ws.id]).catch(() => undefined);
    await admin?.end();
  });

  // ---------------------------------------------------------------------------------------------------------- §1 MFA
  describe('§1 MFA (TOTP replay protection, recovery codes)', () => {
    let a: { user: string; org: string };
    let b: { user: string; org: string };
    beforeAll(async () => {
      a = await newOrgUser('mfa-a');
      b = await newOrgUser('mfa-b');
    });

    it('the runtime role can neither read the secret nor write any MFA column directly (guard trigger, 42501)', async () => {
      await asApp({ org: a.org, uid: a.user }, async (c) => {
        expect(await spq(c, 'SELECT totp_secret_encrypted FROM core."user" WHERE id = $1', [a.user])).toBe('42501');
      }, false);
      for (const sql of [
        `UPDATE core."user" SET totp_enabled = false WHERE id = $1`,
        `UPDATE core."user" SET totp_last_used_step = 0 WHERE id = $1`,
        `UPDATE core."user" SET mfa_enabled_at = now() WHERE id = $1`,
        `UPDATE core."user" SET totp_secret_encrypted = NULL WHERE id = $1`,
      ]) {
        // totp_enabled=false on a row that already is false is a no-op and allowed; make it a real change first.
        await admin.query(`UPDATE core."user" SET totp_secret_encrypted = $2 WHERE id = $1`, [a.user, rab2()]);
        const code = await asApp({ org: a.org, uid: a.user }, (c) => spq(c, sql.replace('= false', '= true'), [a.user]), false);
        expect(code).toBe('42501');
      }
      const ins = await asApp({ org: a.org, uid: a.user }, (c) =>
        spq(c, `INSERT INTO core."user"(organisation_id, email, first_name, last_name, status, totp_enabled) VALUES ($1, $2, 'x', 'y', 'active', true)`, [a.org, `ins-${sfx}@db5.invalid`]), false);
      expect(['42501', '23514']).toContain(ins);
      await admin.query(`UPDATE core."user" SET totp_secret_encrypted = NULL WHERE id = $1`, [a.user]);
    });

    it('stage → enable → accept: the confirming step and every older/equal step are refused (replay), future steps are 22023', async () => {
      const s = nowStep();
      await asApp({ org: a.org, uid: a.user }, async (c) => {
        expect((await c.query('SELECT core.mfa_stage_totp_secret($1, $2) AS ok', [a.user, rab2()])).rows[0].ok).toBe(true);
        expect((await c.query('SELECT core.mfa_enable_totp($1, $2) AS ok', [a.user, s])).rows[0].ok).toBe(true);
        // Already enabled: staging a new secret over an active factor is refused.
        expect((await c.query('SELECT core.mfa_stage_totp_secret($1, $2) AS ok', [a.user, rab2()])).rows[0].ok).toBe(false);
        expect((await c.query('SELECT core.mfa_accept_totp_step($1, $2) AS ok', [a.user, s])).rows[0].ok).toBe(false);
        expect((await c.query('SELECT core.mfa_accept_totp_step($1, $2) AS ok', [a.user, s - 1])).rows[0].ok).toBe(false);
        expect((await c.query('SELECT core.mfa_accept_totp_step($1, $2) AS ok', [a.user, s + 1])).rows[0].ok).toBe(true);
        expect((await c.query('SELECT core.mfa_accept_totp_step($1, $2) AS ok', [a.user, s + 1])).rows[0].ok).toBe(false);
        expect(await spq(c, 'SELECT core.mfa_accept_totp_step($1, $2)', [a.user, s + 10_000])).toBe('22023');
      });
      const st = await asApp({ org: a.org, uid: a.user }, async (c) => (await c.query('SELECT * FROM core.mfa_totp_state($1)', [a.user])).rows);
      expect(st).toEqual([expect.objectContaining({ totp_enabled: true, totp_last_used_step: String(s + 1) })]);
      expect(st[0].mfa_enabled_at).toBeInstanceOf(Date);
    });

    it('two concurrent submissions of the same new step: exactly one wins (row lock + conditional UPDATE)', async () => {
      const r = await newOrgUser('mfa-race');
      const target = nowStep();
      await asApp({ org: r.org, uid: r.user }, async (c) => {
        expect((await c.query('SELECT core.mfa_stage_totp_secret($1, $2) AS ok', [r.user, rab2()])).rows[0].ok).toBe(true);
        expect((await c.query('SELECT core.mfa_enable_totp($1, $2) AS ok', [r.user, target - 1])).rows[0].ok).toBe(true);
      });
      const a = r;
      const c1 = await app();
      const c2 = await app();
      for (const c of [c1, c2]) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [a.org, a.user]);
      }
      const r1 = await c1.query('SELECT core.mfa_accept_totp_step($1, $2) AS ok', [a.user, target]);
      const p2 = c2.query('SELECT core.mfa_accept_totp_step($1, $2) AS ok', [a.user, target]); // blocks on the row lock
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const r2 = await p2;
      await c2.query('COMMIT');
      expect([r1.rows[0].ok, r2.rows[0].ok].sort()).toEqual([false, true]);
    });

    it('self-scoped functions refuse another user of the SAME organisation (stage, enable, accept, codes)', async () => {
      const peer = (await admin.query(
        `INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Peer', 'User', 'active') RETURNING id`,
        [a.org, `peer-${sfx}@db5.invalid`],
      )).rows[0].id as string;
      await asApp({ org: a.org, uid: peer }, async (c) => {
        expect((await c.query('SELECT core.mfa_accept_totp_step($1, $2) AS ok', [a.user, nowStep()])).rows[0].ok).toBe(false);
        expect((await c.query('SELECT core.mfa_stage_totp_secret($1, $2) AS ok', [a.user, rab2()])).rows[0].ok).toBe(false);
        expect((await c.query('SELECT core.mfa_replace_recovery_codes($1, $2) AS n', [a.user, [hex64()]])).rows[0].n).toBe(0);
        expect((await c.query('SELECT core.mfa_consume_recovery_code($1, $2) AS ok', [a.user, hex64()])).rows[0].ok).toBe(false);
      });
    });

    it('cross-tenant and no-context calls are refused indistinguishably (false / zero rows)', async () => {
      await asApp({ org: b.org, uid: a.user }, async (c) => {
        expect((await c.query('SELECT * FROM core.mfa_totp_state($1)', [a.user])).rows).toEqual([]);
        expect((await c.query('SELECT core.mfa_accept_totp_step($1, $2) AS ok', [a.user, nowStep()])).rows[0].ok).toBe(false);
        expect((await c.query('SELECT core.mfa_disable($1) AS ok', [a.user])).rows[0].ok).toBe(false);
      });
      await asApp({}, async (c) => {
        expect((await c.query('SELECT * FROM core.mfa_totp_state($1)', [a.user])).rows).toEqual([]);
        expect((await c.query('SELECT core.mfa_disable($1) AS ok', [a.user])).rows[0].ok).toBe(false);
      });
      expect((await admin.query('SELECT totp_enabled FROM core."user" WHERE id = $1', [a.user])).rows[0].totp_enabled).toBe(true);
    });

    it('recovery codes: stored hashed, never readable by the runtime role, single use, per user, validated set', async () => {
      const codes = Array.from({ length: 10 }, () => randomBytes(8).toString('hex'));
      const hashes = codes.map((c) => sha(`pepper:${c}`));
      await asApp({ org: a.org, uid: a.user }, async (c) => {
        expect((await c.query('SELECT core.mfa_replace_recovery_codes($1, $2) AS n', [a.user, hashes])).rows[0].n).toBe(10);
        expect(await spq(c, 'SELECT code_hash FROM core.user_mfa_recovery_code')).toBe('42501');
        expect((await c.query('SELECT core.mfa_consume_recovery_code($1, $2) AS ok', [a.user, hashes[0]])).rows[0].ok).toBe(true);
        expect((await c.query('SELECT core.mfa_consume_recovery_code($1, $2) AS ok', [a.user, hashes[0]])).rows[0].ok).toBe(false);
        expect((await c.query('SELECT core.mfa_consume_recovery_code($1, $2) AS ok', [a.user, sha('nope')])).rows[0].ok).toBe(false);
        expect((await c.query('SELECT recovery_codes_remaining AS n FROM core.mfa_totp_state($1)', [a.user])).rows[0].n).toBe(9);
        for (const bad of [[], [...hashes, ...hashes.slice(0, 1)], Array.from({ length: 21 }, hex64), ['NOT-HEX'], [hashes[1]!.toUpperCase()]]) {
          expect(await spq(c, 'SELECT core.mfa_replace_recovery_codes($1, $2)', [a.user, bad])).toBe('22023');
        }
      });
      // Another organisation cannot consume A's code even with the right hash.
      await asApp({ org: b.org, uid: a.user }, async (c) => {
        expect((await c.query('SELECT core.mfa_consume_recovery_code($1, $2) AS ok', [a.user, hashes[1]])).rows[0].ok).toBe(false);
      });
      // FORCE RLS binds even the table owner: with no tenant context, the owner sees zero rows (they exist).
      expect((await admin.query('SELECT count(*)::int AS n FROM core.user_mfa_recovery_code WHERE user_id = $1', [a.user])).rows[0].n).toBe(10);
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE rab_secure_owner');
      expect((await admin.query('SELECT count(*)::int AS n FROM core.user_mfa_recovery_code')).rows[0].n).toBe(0);
      await admin.query('ROLLBACK');
    });

    it('the replay counter is forward-only for EVERY writer (even a superuser), and disable clears everything', async () => {
      expect(await sqlstateOf(admin.query('UPDATE core."user" SET totp_last_used_step = 0 WHERE id = $1', [a.user]))).toBe('23514');
      expect(await sqlstateOf(admin.query('UPDATE core."user" SET totp_last_used_step = NULL WHERE id = $1', [a.user]))).toBe('23514');
      await asApp({ org: a.org, uid: a.user }, async (c) => {
        expect((await c.query('SELECT core.mfa_disable($1) AS ok', [a.user])).rows[0].ok).toBe(true);
      });
      const [u] = (await admin.query('SELECT totp_enabled, totp_secret_encrypted, totp_last_used_step, mfa_enabled_at FROM core."user" WHERE id = $1', [a.user])).rows;
      expect(u).toEqual({ totp_enabled: false, totp_secret_encrypted: null, totp_last_used_step: null, mfa_enabled_at: null });
      expect((await admin.query('SELECT count(*)::int AS n FROM core.user_mfa_recovery_code WHERE user_id = $1', [a.user])).rows[0].n).toBe(0);
      // Codes cannot be issued without a staged/enabled secret.
      await asApp({ org: a.org, uid: a.user }, async (c) => {
        expect((await c.query('SELECT core.mfa_replace_recovery_codes($1, $2) AS n', [a.user, [hex64()]])).rows[0].n).toBe(0);
      });
    });

    it('rotation re-encrypts an ENABLED secret by compare-and-set only, keeping enabled/step; wrong expected or tenant → false', async () => {
      const r = await newOrgUser('mfa-rot');
      const first = rab2('old');
      const next = rab2('new');
      const st = nowStep() - 1;
      await asApp({ org: r.org, uid: r.user }, async (c) => {
        expect((await c.query('SELECT core.mfa_stage_totp_secret($1, $2) AS ok', [r.user, first])).rows[0].ok).toBe(true);
        expect((await c.query('SELECT core.mfa_enable_totp($1, $2) AS ok', [r.user, st])).rows[0].ok).toBe(true);
        expect((await c.query('SELECT core.mfa_rotate_totp_secret($1, $2, $3) AS ok', [r.user, rab2('other'), next])).rows[0].ok).toBe(false);
        expect(await spq(c, 'SELECT core.mfa_rotate_totp_secret($1, $2, $3)', [r.user, first, Buffer.from('plaintext')])).toBe('23514');
      });
      expect(await asApp({ org: b.org }, async (c) => (await c.query('SELECT core.mfa_rotate_totp_secret($1, $2, $3) AS ok', [r.user, first, next])).rows[0].ok)).toBe(false);
      expect(await asApp({}, async (c) => (await c.query('SELECT core.mfa_rotate_totp_secret($1, $2, $3) AS ok', [r.user, first, next])).rows[0].ok)).toBe(false);
      expect(await asApp({ org: r.org, uid: r.user }, async (c) => (await c.query('SELECT core.mfa_rotate_totp_secret($1, $2, $3) AS ok', [r.user, first, next])).rows[0].ok)).toBe(true);
      const [u] = (await admin.query('SELECT totp_enabled, totp_secret_encrypted, totp_last_used_step FROM core."user" WHERE id = $1', [r.user])).rows;
      expect(u.totp_enabled).toBe(true);
      expect(Buffer.compare(u.totp_secret_encrypted, next)).toBe(0);
      expect(Number(u.totp_last_used_step)).toBe(st);
      await asApp({ org: r.org, uid: r.user }, async (c) => c.query('SELECT core.mfa_disable($1)', [r.user]));
    });

    it('a staged secret must be a RAB2 envelope (23514) — plaintext or legacy layout never lands', async () => {
      await asApp({ org: a.org, uid: a.user }, async (c) => {
        expect(await spq(c, 'SELECT core.mfa_stage_totp_secret($1, $2)', [a.user, Buffer.from('JBSWY3DPEHPK3PXP')])).toBe('23514');
        expect(await spq(c, 'SELECT core.mfa_stage_totp_secret($1, $2)', [a.user, randomBytes(40)])).toBe('23514');
      }, false);
    });
  });

  // ------------------------------------------------------------------------------------------------- §2 login handoff
  describe('§2 cross-host login handoff', () => {
    let ws: SeededWorkspace;
    let session: string;
    const newSession = async (opts: { workspace?: string | null; user?: string; org?: string } = {}) => {
      const id = (await admin.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      await admin.query(
        `INSERT INTO core.user_session (id, organisation_id, user_id, workspace_id, application_target, auth_provider, absolute_expires_at)
         VALUES ($1, $2, $3, $4, 'manager_web', 'password', now() + interval '1 hour')`,
        [id, opts.org ?? ws.org, opts.user ?? ws.owner, opts.workspace === undefined ? ws.id : opts.workspace],
      );
      return id;
    };
    const create = (sess: string, token: string, ttl = 30, ctx = { org: ws.org, uid: ws.owner }) =>
      asApp(ctx, async (c) => (await c.query('SELECT * FROM core.login_handoff_create($1, $2, $3)', [sess, token, ttl])).rows);
    const consume = (token: string, host: string) =>
      asApp({}, async (c) => (await c.query('SELECT * FROM core.login_handoff_consume($1, $2)', [token, host])).rows);

    beforeAll(async () => {
      ws = await readyWorkspace('h');
      session = await newSession();
    });

    it('create derives everything server-side; consume is single use and returns the session facts once', async () => {
      const secret = randomBytes(32).toString('base64url');
      const rows = await create(session, sha(secret));
      expect(rows).toEqual([expect.objectContaining({ audience_label: ws.label })]);
      const life = (await admin.query('SELECT expires_at - created_at AS d FROM core.login_handoff WHERE id = $1', [rows[0].handoff_id])).rows[0].d;
      expect(life.seconds).toBe(30);
      const first = await consume(sha(secret), ws.label.toUpperCase());
      expect(first).toEqual([
        { organisation_id: ws.org, user_id: ws.owner, workspace_id: ws.id, application_target: 'manager_web', auth_provider: 'password', mfa_verified_at: null, source_session_id: session },
      ]);
      expect(await consume(sha(secret), ws.label)).toEqual([]);
    });

    it('the runtime role has no table privilege; a probe role subject to the policy sees zero rows with no context', async () => {
      await asApp({ org: ws.org }, async (c) => {
        expect(await spq(c, 'SELECT 1 FROM core.login_handoff')).toBe('42501');
        expect(await spq(c, `DELETE FROM core.login_handoff`)).toBe('42501');
      }, false);
      await create(session, hex64());
      await admin.query('BEGIN');
      try {
        await admin.query(`CREATE ROLE db5_probe_${sfx} NOLOGIN`);
        await admin.query(`GRANT USAGE ON SCHEMA core TO db5_probe_${sfx}; GRANT SELECT ON core.login_handoff TO db5_probe_${sfx}`);
        await admin.query(`SET LOCAL ROLE db5_probe_${sfx}`);
        expect((await admin.query('SELECT count(*)::int AS n FROM core.login_handoff')).rows[0].n).toBe(0);
        await admin.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ws.org]);
        expect((await admin.query('SELECT count(*)::int AS n FROM core.login_handoff')).rows[0].n).toBeGreaterThan(0);
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('a presented live token is burned even on the wrong host (audience-bound), and a wrong host never gets the facts', async () => {
      const t = hex64();
      await create(session, t);
      expect(await consume(t, 'evil')).toEqual([]);
      expect(await consume(t, ws.label)).toEqual([]);
      expect((await admin.query('SELECT consumed_at IS NOT NULL AS c FROM core.login_handoff WHERE token_hash = $1', [t])).rows[0].c).toBe(true);
    });

    it('two concurrent redemptions of one token: exactly one wins', async () => {
      const t = hex64();
      await create(session, t);
      const results = await Promise.all([consume(t, ws.label), consume(t, ws.label), consume(t, ws.label)]);
      expect(results.filter((r) => r.length === 1).length).toBe(1);
    });

    it('lifetime ≤ 60 s (TTL clamped, table CHECK), expiry refuses', async () => {
      const t = hex64();
      const [row] = await create(session, t, 3600);
      const life = (await admin.query('SELECT expires_at - created_at AS d FROM core.login_handoff WHERE id = $1', [row.handoff_id])).rows[0].d;
      expect(life.minutes ?? 0).toBe(1);
      expect(await sqlstateOf(admin.query(`UPDATE core.login_handoff SET expires_at = created_at + interval '61 seconds' WHERE id = $1`, [row.handoff_id]))).toBe('23514');
      const short = hex64();
      await create(session, short, 1);
      await new Promise((r) => setTimeout(r, 1500));
      expect(await consume(short, ws.label)).toEqual([]);
    });

    it('session revoke, security_version bump, workspace rename and org suspension each invalidate a live handoff', async () => {
      const cases: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
        ['session revoked', async () => admin.query(`UPDATE core.user_session SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1`, [session]), async () => {
          session = await newSession();
        }],
        ['security_version', async () => admin.query('UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1', [ws.owner]), async () => undefined],
        ['suspended', async () => admin.query('UPDATE core.organisation SET suspended_at = now(), suspended_by = $2 WHERE id = $1', [ws.org, ws.owner]), async () =>
          admin.query('UPDATE core.organisation SET suspended_at = NULL, suspended_by = NULL WHERE id = $1', [ws.org])],
        // Last: the rename keeps the new label (the old one is quarantined) — later handoffs target the new label.
        ['renamed', async () => admin.query('UPDATE core.manager_workspace SET subdomain = $2 WHERE id = $1', [ws.id, `${ws.label}-r`]), async () => {
          ws = { ...ws, label: `${ws.label}-r` };
        }],
      ];
      for (const [, breakIt, repair] of cases) {
        const t = hex64();
        expect(await create(session, t)).toHaveLength(1);
        await breakIt();
        expect(await consume(t, ws.label)).toEqual([]);
        await repair();
      }
    });

    it('create refuses another user\'s session, a session with no workspace, no context, a bad hash, and > 5 live (CWH01)', async () => {
      const other = await newOrgUser('h-other');
      const foreign = await newSession({ user: other.user, org: other.org, workspace: null });
      expect(await create(foreign, hex64())).toEqual([]);
      const noWs = await newSession({ workspace: null });
      expect(await create(noWs, hex64())).toEqual([]);
      expect(await asApp({}, async (c) => (await c.query('SELECT * FROM core.login_handoff_create($1, $2)', [session, hex64()])).rows)).toEqual([]);
      expect(await asApp({ org: ws.org, uid: ws.owner }, (c) => spq(c, 'SELECT * FROM core.login_handoff_create($1, $2)', [session, 'abc']), false)).toBe('22023');
      await admin.query(`UPDATE core.login_handoff SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [ws.owner]);
      for (let i = 0; i < 5; i += 1) expect(await create(session, hex64())).toHaveLength(1);
      expect(await asApp({ org: ws.org, uid: ws.owner }, (c) => spq(c, 'SELECT * FROM core.login_handoff_create($1, $2)', [session, hex64()]), false)).toBe('CWH01');
    });

    it('peek (pre-auth) returns display fields only, never consumes or extends, and is empty whenever consume would refuse', async () => {
      await admin.query(`UPDATE core.login_handoff SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [ws.owner]);
      const t = hex64();
      const [row] = await create(session, t);
      const peek = (host: string) => asApp({}, async (c) => (await c.query('SELECT * FROM core.login_handoff_peek($1, $2)', [t, host])).rows);
      const [{ email }] = (await admin.query('SELECT email FROM core."user" WHERE id = $1', [ws.owner])).rows;
      const first = await peek(ws.label);
      expect(first).toEqual([{ workspace_display_name: expect.any(String), masked_email: `${email[0]}***@${email.split('@')[1]}`, expires_at: row.expires_at }]);
      expect(JSON.stringify(first)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no ids
      expect(await peek(ws.label)).toHaveLength(1); // repeatable: not consumed
      expect(await peek('evil')).toEqual([]);
      const [after] = (await admin.query('SELECT consumed_at, expires_at FROM core.login_handoff WHERE id = $1', [row.handoff_id])).rows;
      expect(after).toEqual({ consumed_at: null, expires_at: row.expires_at });
      // STABLE: the function body cannot write even if it tried; a wrong host did not burn it either — consume still works once.
      const [{ provolatile }] = (await admin.query(`SELECT provolatile FROM pg_proc WHERE oid = 'core.login_handoff_peek(text, text)'::regprocedure`)).rows;
      expect(provolatile).toBe('s');
      expect(await consume(t, ws.label)).toHaveLength(1);
      expect(await peek(ws.label)).toEqual([]);
      expect(await asApp({}, async (c) => (await c.query('SELECT * FROM core.login_handoff_peek($1, $2)', ['nothex', ws.label])).rows)).toEqual([]);
    });

    it('a session may record mfa_verified_at at INSERT only if its user holds an enabled factor and never in the future; no UPDATE', async () => {
      const ins = (ctx: { org: string; uid: string }, user: string, at: string) =>
        asApp(ctx, (c) => spq(c,
          `INSERT INTO core.user_session (id, organisation_id, user_id, application_target, absolute_expires_at, mfa_verified_at)
           VALUES (gen_random_uuid(), $1, $2, 'manager_web', now() + interval '1 hour', ${at})`, [ctx.org, user]), true);
      const ctx = { org: ws.org, uid: ws.owner };
      expect(await ins(ctx, ws.owner, 'now()')).toBe('23514'); // no enabled factor
      await asApp(ctx, async (c) => {
        expect((await c.query('SELECT core.mfa_stage_totp_secret($1, $2) AS ok', [ws.owner, rab2()])).rows[0].ok).toBe(true);
        expect((await c.query('SELECT core.mfa_enable_totp($1, $2) AS ok', [ws.owner, nowStep() - 1])).rows[0].ok).toBe(true);
      });
      expect(await ins(ctx, ws.owner, "now() + interval '1 hour'")).toBe('23514');
      expect(await ins(ctx, ws.owner, "now() - interval '2 hours'")).toBe('ACCEPTED');
      expect(await asApp(ctx, (c) => spq(c, `UPDATE core.user_session SET mfa_verified_at = now() WHERE user_id = $1`, [ws.owner]), false)).toBe('42501');
      await asApp(ctx, async (c) => c.query('SELECT core.mfa_disable($1)', [ws.owner]));
    });

    it('cleanup deletes only rows expired/consumed more than an hour ago', async () => {
      await admin.query(`UPDATE core.login_handoff SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [ws.owner]);
      const t = hex64();
      const [row] = await create(session, t);
      expect(await create(session, hex64())).toHaveLength(1); // a live one that must survive the cleanup
      await admin.query(`UPDATE core.login_handoff SET created_at = now() - interval '2 hours', expires_at = now() - interval '2 hours' + interval '30 seconds' WHERE id = $1`, [row.handoff_id]);
      const n = await asApp({}, async (c) => (await c.query('SELECT rows_deleted FROM core.login_handoff_cleanup(1000)')).rows[0].rows_deleted);
      expect(n).toBeGreaterThanOrEqual(1);
      expect((await admin.query('SELECT count(*)::int AS n FROM core.login_handoff WHERE id = $1', [row.handoff_id])).rows[0].n).toBe(0);
      expect((await admin.query(`SELECT count(*)::int AS n FROM core.login_handoff WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()`, [ws.owner])).rows[0].n).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------- §0 compatibility with images that still build module 15
  describe('§0 version-aware verification (running images keep provisioning v15 until rebuilt)', () => {
    it('a schema stopped at module 15 verifies at v15 (90 indexes) and is refused if the registry claims 17; the migrator then lifts it', async () => {
      const ws = await seedWorkspace(admin, `db5v15-${sfx}`);
      workspaces.push(ws);
      await provisionLegacyV14(adminUrl, ws);
      const crewflow = new Client({ connectionString: adminUrl });
      await crewflow.connect();
      clients.push(crewflow);
      await crewflow.query('SET ROLE crewflow');
      const migrator = new WorkspaceSchemaMigrator(pgClientRunner(crewflow));
      const [to15] = await migrator.migrateAll({ workspaceIds: [ws.id], throughVersion: 15 });
      expect(to15).toMatchObject({ status: 'MIGRATED', toVersion: 15 });
      const verify = async () => {
        await admin.query('BEGIN');
        await admin.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ws.org]);
        const p = (await admin.query('SELECT core.verify_workspace_schema_v1($1) AS p', [ws.id])).rows[0].p;
        await admin.query('ROLLBACK');
        return p;
      };
      expect(await verify()).toBeNull();
      expect((await admin.query('SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1', [ws.schema])).rows[0].n).toBe(90);
      // A registry that claims a version the schema does not have fails verification (fail closed).
      await admin.query('BEGIN');
      await admin.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ws.org]);
      await admin.query('UPDATE core.workspace_schema_registry SET module_version = 17 WHERE workspace_id = $1', [ws.id]);
      expect((await admin.query('SELECT core.verify_workspace_schema_v1($1) AS p', [ws.id])).rows[0].p).toBe('index count');
      await admin.query('ROLLBACK');
      const [to17] = await migrator.migrateAll({ workspaceIds: [ws.id] });
      expect(to17).toMatchObject({ status: 'MIGRATED', fromVersion: 15, toVersion: LATEST_WORKSPACE_MODULE_VERSION });
      expect(await verify()).toBeNull();
      expect((await registryOf(admin, ws.id)).expected_fingerprint).toBe(EXPECTED_WORKSPACE_FINGERPRINTS[LATEST_WORKSPACE_MODULE_VERSION]);
    });
  });

  // ------------------------------------------------------------------------------------------------------ §3 archive
  describe('§3 archive / restore', () => {
    let ws: SeededWorkspace;
    let venue: string;
    let role: string;
    beforeAll(async () => {
      ws = await readyWorkspace('a');
      venue = (await admin.query(`INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, 'Hall', $3) RETURNING id`, [ws.org, ws.id, ws.owner])).rows[0].id;
      role = (await admin.query(`INSERT INTO core.job_role (organisation_id, workspace_id, name) VALUES ($1, $2, 'Bartender') RETURNING id`, [ws.org, ws.id])).rows[0].id;
    });
    const shift = async (status: string) =>
      (await admin.query(
        `INSERT INTO core.shift (organisation_id, workspace_id, venue_id, job_role_id, starts_at, ends_at, required_count, pay_rate_pence, created_by, status)
         VALUES ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day 4 hours', 1, 1200, $5, $6) RETURNING id`,
        [ws.org, ws.id, venue, role, ws.owner, status],
      )).rows[0].id as string;

    it('archive is a named pair: both columns or neither (23514), in core and in every workspace schema', async () => {
      expect(await sqlstateOf(admin.query('UPDATE core.venue SET archived_at = now() WHERE id = $1', [venue]))).toBe('23514');
      expect(await sqlstateOf(admin.query('UPDATE core.venue SET archived_by = $2 WHERE id = $1', [venue, ws.owner]))).toBe('23514');
      const n = await asApp({ org: ws.org, ws: ws.id }, async (c) =>
        (await c.query('UPDATE core.venue SET archived_at = now(), archived_by = $2 WHERE id = $1', [venue, ws.owner])).rowCount);
      expect(n).toBe(1);
      // Another tenant cannot archive it (zero rows, not an error).
      const other = await newOrgUser('arch-b');
      expect(await asApp({ org: other.org }, async (c) => (await c.query('UPDATE core.venue SET archived_at = now(), archived_by = $2 WHERE id = $1', [venue, other.user])).rowCount)).toBe(0);
      // Restore.
      expect(await asApp({ org: ws.org, ws: ws.id }, async (c) => (await c.query('UPDATE core.venue SET archived_at = NULL, archived_by = NULL WHERE id = $1', [venue])).rowCount)).toBe(1);
      const wsChecks = (await admin.query(
        `SELECT conrelid::regclass::text AS t, conname FROM pg_constraint WHERE connamespace = $1::regnamespace AND conname LIKE '%archived%' ORDER BY 1, 2`,
        [ws.schema],
      )).rows.map((r) => `${r.t.split('.')[1]}.${r.conname}`);
      expect(wsChecks).toEqual([
        'job_role.job_role_archived_pair_check',
        'shift.shift_archived_draft_only_check',
        'shift.shift_archived_pair_check',
        'staff_profile.staff_profile_archived_pair_check',
        'venue.venue_archived_pair_check',
      ]);
    });

    it('only draft shifts are archivable, and an archived draft cannot be published until restored', async () => {
      const open = await shift('open');
      expect(await sqlstateOf(admin.query('UPDATE core.shift SET archived_at = now(), archived_by = $2 WHERE id = $1', [open, ws.owner]))).toBe('23514');
      const draft = await shift('draft');
      await admin.query('UPDATE core.shift SET archived_at = now(), archived_by = $2 WHERE id = $1', [draft, ws.owner]);
      expect(await sqlstateOf(admin.query(`UPDATE core.shift SET status = 'open' WHERE id = $1`, [draft]))).toBe('23514');
      await admin.query('UPDATE core.shift SET archived_at = NULL, archived_by = NULL WHERE id = $1', [draft]);
      await admin.query(`UPDATE core.shift SET status = 'open' WHERE id = $1`, [draft]);
    });

    it('uniques stay total: an archived role keeps its name (create → 23505), so restore can never conflict', async () => {
      await admin.query('UPDATE core.job_role SET archived_at = now(), archived_by = $2 WHERE id = $1', [role, ws.owner]);
      expect(await sqlstateOf(admin.query(`INSERT INTO core.job_role (organisation_id, workspace_id, name) VALUES ($1, $2, 'Bartender')`, [ws.org, ws.id]))).toBe('23505');
      expect((await admin.query('UPDATE core.job_role SET archived_at = NULL, archived_by = NULL WHERE id = $1', [role])).rowCount).toBe(1);
    });

    it('no archive column exists on any payroll, payslip, attendance, report or audit table (core or workspace)', async () => {
      const rows = (await admin.query(
        `SELECT n.nspname, c.relname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE a.attname IN ('archived_at', 'archived_by', 'deleted_at') AND NOT a.attisdropped AND c.relkind = 'r'
            AND (n.nspname = 'core' OR n.nspname = $1)
            AND c.relname ~ '^(payroll|payslip|attendance|shift_report|audit_log|pay_)'`,
        [ws.schema],
      )).rows;
      expect(rows).toEqual([]);
      const archivable = (await admin.query(
        `SELECT DISTINCT c.relname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE a.attname = 'archived_at' AND NOT a.attisdropped AND n.nspname = 'core' AND c.relkind = 'r' ORDER BY 1`,
      )).rows.map((r) => r.relname);
      expect(archivable).toEqual(['job_role', 'manager_profile', 'shift', 'staff_profile', 'venue']);
    });

    it('the migrated workspace is at the latest module with ledger rows and the expected fingerprint', async () => {
      const reg = await registryOf(admin, ws.id);
      expect(reg).toMatchObject({ status: 'READY', module_version: LATEST_WORKSPACE_MODULE_VERSION, drift_status: 'OK' });
      expect(reg.expected_fingerprint).toBe(EXPECTED_WORKSPACE_FINGERPRINTS[LATEST_WORKSPACE_MODULE_VERSION]);
      const ids = (await ledgerOf(admin, ws.id)).map((l) => l.module_id);
      expect(ids).toEqual(expect.arrayContaining(['v1.016-archive-columns', 'v1.017-search-vectors']));
    });
  });

  // ------------------------------------------------------------------------------------------------------- §4 search
  describe('§4 search vectors and trigram indexes', () => {
    let ws: SeededWorkspace;
    let other: SeededWorkspace;
    beforeAll(async () => {
      ws = await readyWorkspace('s');
      other = await readyWorkspace('s2');
      await admin.query(`INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Zoë', 'Brontë', 'active')`, [ws.org, `searchme-${sfx}@db5.invalid`]);
      await admin.query(`INSERT INTO core.venue (organisation_id, workspace_id, name, client_name, created_by) VALUES ($1, $2, 'Café Ünïon', 'Société Générale', $3)`, [ws.org, ws.id, ws.owner]);
      await admin.query(`INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, 'Café Ünïon', $3)`, [other.org, other.id, other.owner]);
    });

    it('accent-insensitive prefix search on names; another tenant and no context see nothing; email never matches', async () => {
      const q = `SELECT first_name FROM core."user" WHERE search_vector @@ to_tsquery('pg_catalog.simple', core.immutable_unaccent(lower($1)) || ':*')`;
      expect((await asApp({ org: ws.org }, async (c) => (await c.query(q, ['zoe'])).rows)).map((r) => r.first_name)).toEqual(['Zoë']);
      expect((await asApp({ org: ws.org }, async (c) => (await c.query(q, ['BRONT'])).rows)).length).toBe(1);
      expect((await asApp({ org: ws.org }, async (c) => (await c.query(q, [`searchme`])).rows)).length).toBe(0);
      expect((await asApp({ org: other.org }, async (c) => (await c.query(q, ['zoe'])).rows)).length).toBe(0);
      expect((await asApp({}, async (c) => (await c.query(q, ['zoe'])).rows)).length).toBe(0);
      const vq = `SELECT name FROM core.venue WHERE core.immutable_unaccent(lower(name)) LIKE '%' || core.immutable_unaccent(lower($1)) || '%'`;
      expect((await asApp({ org: ws.org, ws: ws.id }, async (c) => (await c.query(vq, ['cafe un'])).rows)).length).toBe(1);
      expect((await asApp({ org: ws.org, ws: ws.id }, async (c) =>
        (await c.query(`SELECT 1 FROM core.venue WHERE search_vector @@ to_tsquery('pg_catalog.simple', 'societe:*')`)).rows)).length).toBe(1);
    });

    it('the planner can use the GIN indexes for the exact contract expressions (seq scans disabled)', async () => {
      const plan = async (sql: string) => {
        await admin.query('BEGIN');
        await admin.query('SET LOCAL enable_seqscan = off');
        const r = (await admin.query(`EXPLAIN ${sql}`)).rows.map((x) => x['QUERY PLAN']).join('\n');
        await admin.query('ROLLBACK');
        return r;
      };
      expect(await plan(`SELECT id FROM core."user" WHERE search_vector @@ to_tsquery('pg_catalog.simple', 'zoe:*')`)).toContain('user_search_vector_idx');
      expect(await plan(`SELECT id FROM core.venue WHERE core.immutable_unaccent(lower(name)) LIKE '%cafe%'`)).toContain('venue_name_trgm_idx');
      expect(await plan(`SELECT id FROM ${ws.schema}.staff_profile WHERE lower(staff_ref) LIKE '%s00%'`)).toContain('staff_profile_staff_ref_trgm_idx');
      expect(await plan(`SELECT id FROM ${ws.schema}.shift WHERE search_vector @@ to_tsquery('pg_catalog.simple', 'dock:*')`)).toContain('shift_search_vector_idx');
    });

    it('the unaccent wrapper is IMMUTABLE and immune to search_path (fully qualified)', async () => {
      const [{ v, vol }] = (await admin.query(`SELECT provolatile AS vol, prosecdef AS v FROM pg_proc WHERE oid = 'core.immutable_unaccent(text)'::regprocedure`)).rows;
      expect(vol).toBe('i');
      expect(v).toBe(false);
      await admin.query('BEGIN');
      await admin.query('SET LOCAL search_path = pg_temp');
      expect((await admin.query(`SELECT core.immutable_unaccent('Ünïon Café') AS s`)).rows[0].s).toBe('Union Cafe');
      await admin.query('ROLLBACK');
    });
  });

  // ------------------------------------------------------------------------------------------------------- §5 outbox
  describe('§5 outbox retention purge and replay', () => {
    let a: { user: string; org: string };
    let b: { user: string; org: string };
    const email = async (org: string, status: string, ageDays: number, extra: Record<string, unknown> = {}) => {
      const cols = { rendered_html: '<p>hello</p>', last_error_code: null as string | null, job_type: 'NOTIFICATION', ...extra };
      return (await admin.query(
        `INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject, rendered_html, last_error_code,
                                        sent_at, failed_at, cancelled_at, created_at, updated_at)
         VALUES ($1, $3, $2, 'x@db5.invalid', 's', $4, $5,
                 CASE WHEN $2 = 'SENT' THEN now() - make_interval(days => $6) END,
                 CASE WHEN $2 = 'FAILED' THEN now() - make_interval(days => $6) END,
                 CASE WHEN $2 = 'CANCELLED' THEN now() - make_interval(days => $6) END,
                 now() - make_interval(days => $6 + 1), now() - make_interval(days => $6)) RETURNING id`,
        [org, status, cols.job_type, cols.rendered_html, cols.last_error_code, ageDays],
      )).rows[0].id as string;
    };
    beforeAll(async () => {
      a = await newOrgUser('ob-a');
      b = await newOrgUser('ob-b');
    });

    it('the runtime role can no longer DELETE outbox rows directly (42501) on any of the four tables', async () => {
      for (const t of ['email_outbox', 'push_delivery', 'realtime_event', 'worker_event']) {
        expect(await asApp({ org: a.org }, (c) => spq(c, `DELETE FROM core.${t}`), false)).toBe('42501');
      }
    });

    it('purge removes only old TERMINAL rows of the bound tenant; never pending/retry/processing; floors enforced', async () => {
      const oldSent = await email(a.org, 'SENT', 40);
      const oldFailed = await email(a.org, 'FAILED', 40);
      const recentSent = await email(a.org, 'SENT', 2);
      const oldPending = await email(a.org, 'PENDING', 40);
      const oldRetry = await email(a.org, 'RETRY', 40);
      const otherOld = await email(b.org, 'SENT', 40);
      const n = await asApp({ org: a.org }, async (c) => (await c.query(`SELECT core.purge_terminal_email_outbox(interval '30 days', 1000) AS n`)).rows[0].n);
      expect(n).toBe(2);
      const left = (await admin.query('SELECT id FROM core.email_outbox WHERE id = ANY($1::uuid[])', [[oldSent, oldFailed, recentSent, oldPending, oldRetry, otherOld]])).rows.map((r) => r.id);
      expect(left.sort()).toEqual([recentSent, oldPending, oldRetry, otherOld].sort());
      await asApp({ org: a.org }, async (c) => {
        expect(await spq(c, `SELECT core.purge_terminal_email_outbox(interval '29 days', 10)`)).toBe('22023');
        expect(await spq(c, `SELECT core.purge_terminal_email_outbox(NULL, 10)`)).toBe('22023');
        expect(await spq(c, `SELECT core.purge_terminal_email_outbox(interval '30 days', 0)`)).toBe('22023');
        expect(await spq(c, `SELECT core.purge_terminal_realtime_event(interval '6 days', 10)`)).toBe('22023');
      }, false);
      expect(await asApp({}, async (c) => (await c.query(`SELECT core.purge_terminal_email_outbox(interval '30 days', 1000) AS n`)).rows[0].n)).toBe(0);
      expect((await admin.query('SELECT count(*)::int AS n FROM core.email_outbox WHERE id = $1', [otherOld])).rows[0].n).toBe(1);
    });

    it('a row locked by a concurrent writer (e.g. a replay in flight) is skipped, not deleted', async () => {
      const id = await email(a.org, 'FAILED', 40);
      const holder = await app();
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('rab.organisation_id', $1, true)`, [a.org]);
      await holder.query('SELECT id FROM core.email_outbox WHERE id = $1 FOR UPDATE', [id]);
      expect(await asApp({ org: a.org }, async (c) => (await c.query(`SELECT core.purge_terminal_email_outbox(interval '30 days', 1000) AS n`)).rows[0].n)).toBe(0);
      await holder.query('ROLLBACK');
      expect(await asApp({ org: a.org }, async (c) => (await c.query(`SELECT core.purge_terminal_email_outbox(interval '30 days', 1000) AS n`)).rows[0].n)).toBe(1);
    });

    it('realtime/worker_event: workspace-tagged rows are purged only under that workspace\'s context', async () => {
      const ws = await readyWorkspace('ob');
      const ev = async (table: string, workspace: string | null) =>
        (await admin.query(
          `INSERT INTO core.${table} (organisation_id, workspace_id, event_key, event_type, entity_type, entity_id, status, processed_at, updated_at)
           VALUES ($1, $2, gen_random_uuid()::text, 't', 'e', gen_random_uuid(), 'completed', now() - interval '40 days', now() - interval '40 days') RETURNING id`,
          [ws.org, workspace],
        )).rows[0].id as string;
      for (const t of ['realtime_event', 'worker_event']) {
        const orgRow = await ev(t, null);
        const wsRow = await ev(t, ws.id);
        expect(await asApp({ org: ws.org }, async (c) => (await c.query(`SELECT core.purge_terminal_${t}(interval '30 days', 1000) AS n`)).rows[0].n)).toBe(1);
        expect((await admin.query(`SELECT id FROM core.${t} WHERE id = ANY($1::uuid[])`, [[orgRow, wsRow]])).rows.map((r) => r.id)).toEqual([wsRow]);
        expect(await asApp({ org: ws.org, ws: ws.id }, async (c) => (await c.query(`SELECT core.purge_terminal_${t}(interval '30 days', 1000) AS n`)).rows[0].n)).toBe(1);
      }
    });

    it('replay: FAILED with a body → RETRY + generation bump + audit row; refuses scrubbed, uncertain, other-tenant and unattributed', async () => {
      const ok = await email(a.org, 'FAILED', 1, { last_error_code: 'SMTP_REJECTED' });
      const scrubbed = await email(a.org, 'FAILED', 1, { job_type: 'PASSWORD_RESET', rendered_html: null });
      const uncertain = await email(a.org, 'FAILED', 1, { last_error_code: 'DELIVERY_UNCERTAIN' });
      const [{ g }] = (await admin.query('SELECT dispatch_generation AS g FROM core.email_outbox WHERE id = $1', [ok])).rows;
      const replay = (id: string, ctx: { org?: string; uid?: string }, allow = false) =>
        asApp(ctx, async (c) => (await c.query('SELECT core.replay_failed_email($1, $2) AS r', [id, allow])).rows[0].r);
      expect(await replay(ok, { org: a.org, uid: a.user })).toBe('REPLAYED');
      const [row] = (await admin.query('SELECT status, dispatch_generation, infrastructure_attempt_count, failed_at, last_error_code FROM core.email_outbox WHERE id = $1', [ok])).rows;
      expect(row).toEqual({ status: 'RETRY', dispatch_generation: g + 1, infrastructure_attempt_count: 0, failed_at: null, last_error_code: null });
      const audit = (await admin.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE action = 'email.replay_requested' AND entity_id = $1`, [ok])).rows;
      expect(audit).toEqual([{ actor_user_id: a.user, metadata: expect.objectContaining({ previousErrorCode: 'SMTP_REJECTED', newGeneration: g + 1 }) }]);
      expect(await replay(ok, { org: a.org, uid: a.user })).toBe('NOT_FOUND');
      expect(await replay(scrubbed, { org: a.org, uid: a.user })).toBe('NO_BODY');
      expect(await replay(uncertain, { org: a.org, uid: a.user })).toBe('UNCERTAIN');
      expect(await replay(uncertain, { org: b.org, uid: b.user }, true)).toBe('NOT_FOUND');
      expect(await replay(uncertain, { org: a.org }, true)).toBe('NOT_FOUND');
      expect(await replay(uncertain, { org: a.org, uid: a.user }, true)).toBe('REPLAYED');
    });
  });

  // ------------------------------------------------------------------------------------- §6 timeline, §7 envelope, §8 field perms
  describe('§6–§8 timeline index, envelope CHECKs, field-permission object keys', () => {
    it('timeline index exists and is valid; the old prefix index is gone; the keyset query uses it', async () => {
      const idx = (await admin.query(
        `SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE i.indrelid = 'core.audit_log'::regclass AND c.relname IN ('audit_log_timeline_idx', 'audit_log_entity_idx')`,
      )).rows;
      expect(idx).toEqual([{ relname: 'audit_log_timeline_idx', indisvalid: true }]);
      await admin.query('BEGIN');
      // Planner-independent: with seq/bitmap scans and explicit sorts disabled, an ordered keyset read is only possible
      // through an index that already delivers (organisation, entity, created_at DESC, id DESC) order.
      await admin.query('SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off; SET LOCAL enable_sort = off');
      const plan = (await admin.query(
        `EXPLAIN SELECT id FROM core.audit_log
          WHERE organisation_id = '00000000-0000-4000-8000-0000000000aa' AND entity_type = 'shift' AND entity_id = '00000000-0000-4000-8000-0000000000bb'
          ORDER BY created_at DESC, id DESC LIMIT 50`,
      )).rows.map((r) => r['QUERY PLAN']).join('\n');
      await admin.query('ROLLBACK');
      expect(plan).toContain('audit_log_timeline_idx');
      expect(plan).not.toMatch(/Sort\b/);
    });

    it('encrypted columns accept only RAB2 envelopes (plaintext, legacy layout and truncated values → 23514, never a get_byte error)', async () => {
      const { user, org } = await newOrgUser('env');
      const push = (token: Buffer) =>
        admin.query(`INSERT INTO core.push_device (organisation_id, user_id, device_id, platform, push_token_encrypted) VALUES ($1, $2, $3, 'ios', $4)`, [org, user, `d-${hex64().slice(0, 8)}`, token]);
      await push(rab2('legacy', 0));
      for (const bad of [Buffer.from('ExponentPushToken[abc]'), randomBytes(60), Buffer.from('RAB2'), Buffer.from('RAB2\u0000' + 'x'.repeat(40)), Buffer.concat([Buffer.from('RAB2'), Buffer.from([200]), randomBytes(40)])]) {
        expect(await sqlstateOf(push(bad))).toBe('23514');
      }
      await admin.query(`INSERT INTO core.platform_config (organisation_id) VALUES ($1)`, [org]);
      expect(await sqlstateOf(admin.query(`UPDATE core.platform_config SET smtp_password_encrypted = $2 WHERE organisation_id = $1`, [org, Buffer.from('hunter2')]))).toBe('23514');
      await admin.query(`UPDATE core.platform_config SET smtp_password_encrypted = $2 WHERE organisation_id = $1`, [org, rab2('k2026')]);
      // These fake envelopes are undecryptable on purpose: remove them so suites that scan every encrypted row (secret:rotate)
      // never see them.
      await admin.query(`UPDATE core.platform_config SET smtp_password_encrypted = NULL WHERE organisation_id = $1`, [org]);
      await admin.query(`DELETE FROM core.push_device WHERE user_id = $1`, [user]);
      const v = (await admin.query(
        `SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%envelope_check' ORDER BY 1`,
      )).rows;
      expect(v).toEqual([
        { conname: 'platform_config_smtp_password_envelope_check', convalidated: true },
        { conname: 'push_device_push_token_envelope_check', convalidated: true },
        { conname: 'user_totp_secret_envelope_check', convalidated: true },
      ]);
    });

    it('field-permission object keys: the DATA lane objects are allowed, anything else is refused before any FK', async () => {
      const ws = await readyWorkspace('fp');
      const ghostRole = '00000000-0000-4000-8000-000000000001';
      const ins = (table: string, key: string) =>
        table === 'role_field_permission'
          ? admin.query(`INSERT INTO core.role_field_permission (role_id, workspace_id, organisation_id, object_key, field_key, can_read) VALUES ($1, $2, $3, $4, 'earnedPence', false)`, [ghostRole, ws.id, ws.org, key])
          : admin.query(`INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read) VALUES ($1, $2, $3, $4, false)`, [ghostRole, ws.id, ws.org, key]);
      for (const t of ['role_field_permission', 'role_object_permission']) {
        for (const key of ['attendance', 'offer', 'shift_report', 'staff']) expect(await sqlstateOf(ins(t, key))).toBe('23503'); // CHECK passed, FK refused
        for (const key of ['payroll', 'audit_log', 'user', '']) expect(await sqlstateOf(ins(t, key))).toBe('23514');
      }
    });

    it('field-permission object keys (FieldPermissionPayrollRecordKey1786719990000): payroll_record is a FIELD rule key only, never an object rule key', async () => {
      // Ghost ids: a row-level CHECK is evaluated before the AFTER-row foreign-key triggers, so 23514 = CHECK refused,
      // 23503 = CHECK passed and only the foreign key refused. Nothing is ever written.
      const ws = { id: '00000000-0000-4000-8000-000000000003', org: '00000000-0000-4000-8000-000000000004' };
      const ghostRole = '00000000-0000-4000-8000-000000000002';
      // role_field_permission: the CHECK now passes, so the (ghost-role) FK is what refuses.
      expect(
        await sqlstateOf(
          admin.query(
            `INSERT INTO core.role_field_permission (role_id, workspace_id, organisation_id, object_key, field_key, can_read) VALUES ($1, $2, $3, 'payroll_record', 'amount', false)`,
            [ghostRole, ws.id, ws.org],
          ),
        ),
      ).toBe('23503');
      // role_object_permission: payroll_record must stay refused by the CHECK (no payroll "See" grant via the Roles editor).
      expect(
        await sqlstateOf(
          admin.query(
            `INSERT INTO core.role_object_permission (role_id, workspace_id, organisation_id, object_key, can_read) VALUES ($1, $2, $3, 'payroll_record', false)`,
            [ghostRole, ws.id, ws.org],
          ),
        ),
      ).toBe('23514');
    });
  });
});
