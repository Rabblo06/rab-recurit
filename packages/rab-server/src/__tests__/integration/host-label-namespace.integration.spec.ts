import 'reflect-metadata';
import { Client } from 'pg';

import { HOST_LABEL_RESERVED_SEED } from '../../database/typeorm/core/host-label-reserved-list';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { dropWorkspaceSchema, provisionServerPath, refusalOf, SeededWorkspace, seedWorkspace, sqlstateOf } from './helpers/workspace-fixtures';

/**
 * Wave 3 schema (lane S2 → lane H contract, docs/evidence/wave2-lane-s2/CONTRACT.md): one routing namespace, reserved
 * labels in the DB, rename/reclaim quarantine, pre-auth host lookup. Abuse cases (CLAUDE.md §1.2 testing floor):
 *  - another tenant cannot take a label through the OTHER namespace (slug vs subdomain), nor win a race for it;
 *  - nobody can take a renamed or deleted workspace's old label during the quarantine (takeover of old links);
 *  - reserved / IDN-homograph / brand-prefixed labels are refused at the database, whatever the client sent;
 *  - the pre-auth resolver discloses nothing for unknown, reserved, non-READY or suspended workspaces (identical empty);
 *  - the runtime role has no privilege on the three tables; quarantine rows cannot be deleted by anyone.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

describeIfDb('host-label namespace, reserved labels and quarantine (C1/C2/C4/C5)', () => {
  const { adminUrl, appUrl } = RUN ? resolveIntegrationTestDatabase(process.env) : ({} as never);
  const sfx = Math.random().toString(36).slice(2, 8);
  const L = (n: string) => `s2h-${n}-${sfx}`;
  let admin: Client;
  let app: Client;
  const created: SeededWorkspace[] = [];

  /** Runs `fn` as crewflow_app bound to the workspace owner's verified context, in a transaction that is committed. */
  const asOwner = async <T>(ws: SeededWorkspace, fn: (c: Client) => Promise<T>): Promise<T> => {
    await app.query('BEGIN');
    try {
      await app.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true), set_config('rab.workspace_id', $3, true)`,
        [ws.org, ws.owner, ws.id],
      );
      const out = await fn(app);
      await app.query('COMMIT');
      return out;
    } catch (e) {
      await app.query('ROLLBACK');
      throw e;
    }
  };
  const rename = (ws: SeededWorkspace, to: string) =>
    asOwner(ws, (c) => c.query('UPDATE core.manager_workspace SET subdomain = $2 WHERE id = $1', [ws.id, to]));
  const resolve = async (label: string) => (await app.query('SELECT * FROM core.resolve_workspace_by_host_label($1)', [label])).rows;
  const resolveReleased = async (label: string) => (await app.query('SELECT * FROM core.resolve_released_host_label($1)', [label])).rows;
  const status = async (label: string, exclude: string | null = null) =>
    (await app.query('SELECT core.host_label_status($1, $2) AS s', [label, exclude])).rows[0].s as string;
  const seed = async (n: string, opts: { orgSlug?: string } = {}) => {
    const ws = await seedWorkspace(admin, L(n), opts);
    created.push(ws);
    return ws;
  };
  /** A second workspace in the SAME organisation (another manager). */
  const seedSibling = async (of: SeededWorkspace, n: string) => {
    const u = (
      await admin.query(
        `INSERT INTO core."user"(organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'S2', 'Sibling', 'active') RETURNING id`,
        [of.org, `${L(n)}@s2.invalid`],
      )
    ).rows[0].id;
    const id = (
      await admin.query(
        `INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain, status, schema_status)
         VALUES ($1, $2, $3::text, $3::text, 'active', 'CREATING') RETURNING id`,
        [of.org, u, L(n)],
      )
    ).rows[0].id;
    const ws = { id, org: of.org, owner: u, schema: `workspace_${String(id).replace(/-/g, '')}`, label: L(n) };
    created.push(ws);
    return ws;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    app = new Client({ connectionString: appUrl });
    await app.connect();
  });
  afterAll(async () => {
    for (const ws of created) await dropWorkspaceSchema(admin, ws.schema).catch(() => undefined);
    await app?.end();
    await admin?.end();
  });

  it('the reserved list is seeded (task list ⊆ DB list, Twenty and @rab/shared lists included)', async () => {
    const db = new Set((await admin.query('SELECT label FROM core.reserved_host_label')).rows.map((r) => r.label));
    expect(db.size).toBe(HOST_LABEL_RESERVED_SEED.length);
    const mustHave =
      'app api auth accounts admin mobile m dev staging test qa preview demo docs blog billing ftp ns1 ns2 mx email mail smtp www crewflow adolphus status help support login logout cdn static assets graphql rest healthz workspace security settings system dashboard';
    for (const l of mustHave.split(' ')) expect(db.has(l)).toBe(true);
    for (const l of ['about', 'otel-collector', 'signin', 'payroll', 'payslip', 'autodiscover', 'mta-sts']) expect(db.has(l)).toBe(true);
  });

  it('reserved, IDN, brand-prefixed and badly shaped subdomains are refused by the DATABASE (23514), on insert and rename', async () => {
    const ws = await seed('shape');
    for (const bad of ['admin', 'api', 'crewflow', 'payroll', 'xn--crwflow-9ya', 'ab--cd', 'api-acme', 'www-acme', 'crewflow-support']) {
      expect(await refusalOf(rename(ws, bad))).toEqual({ code: '23514', constraint: 'host_label_reserved' });
    }
    for (const bad of ['ab', '-acme', 'acme-', 'ac_me', 'ac.me', 'a'.repeat(64)]) {
      expect(await refusalOf(rename(ws, bad))).toEqual({ code: '23514', constraint: 'host_label_shape' });
    }
    // Case-insensitive like DNS: a case-only change is not a rename (no quarantine row), and the claim stays lower-case.
    expect(await sqlstateOf(rename(ws, ws.label.toUpperCase()))).toBe('ACCEPTED');
    expect((await admin.query('SELECT count(*)::int AS n FROM core.released_host_label WHERE workspace_id = $1', [ws.id])).rows[0].n).toBe(0);
    expect((await admin.query('SELECT label FROM core.host_label_claim WHERE workspace_id = $1', [ws.id])).rows).toEqual([{ label: ws.label }]);
    expect(await refusalOf(rename(ws, 'ADMIN'))).toEqual({ code: '23514', constraint: 'host_label_reserved' });
    // Direct INSERT path too (bypassing every service): superuser, no RLS.
    const r = await refusalOf(
      admin.query(
        `INSERT INTO core.manager_workspace(organisation_id, owner_user_id, name, subdomain) SELECT organisation_id, owner_user_id, 'x', 'support' FROM core.manager_workspace WHERE id = $1`,
        [ws.id],
      ),
    );
    expect(r).toEqual({ code: '23514', constraint: 'host_label_reserved' });
  });

  it('another organisation cannot take a label through the other namespace (slug ↔ subdomain), case-insensitively', async () => {
    const a = await seed('nsa');
    const b = await seed('nsb');
    // b's org slug is b.label: a cannot rename its workspace to it.
    expect(await refusalOf(rename(a, b.label))).toEqual({ code: '23505', constraint: 'host_label_unavailable' });
    // a's workspace subdomain is a.label: b's organisation cannot take it as a slug (any case).
    expect(await refusalOf(admin.query('UPDATE core.organisation SET slug = $2 WHERE id = $1', [b.org, a.label.toUpperCase()]))).toEqual({
      code: '23505',
      constraint: 'host_label_unavailable',
    });
    // Same organisation overlap is allowed (org slug == own workspace label is what onboarding creates).
    expect((await admin.query('SELECT slug::text AS s FROM core.organisation WHERE id = $1', [a.org])).rows[0].s).toBe(a.label);
    const sib = await seedSibling(a, 'nsa-sib');
    expect(await sqlstateOf(admin.query('UPDATE core.organisation SET slug = $2 WHERE id = $1', [a.org, sib.label]))).toBe('ACCEPTED');
  });

  it('a concurrent cross-namespace race for one label lets exactly one organisation win', async () => {
    const a = await seed('race-a');
    const b = await seed('race-b');
    const target = L('race-x');
    const c1 = new Client({ connectionString: adminUrl });
    const c2 = new Client({ connectionString: adminUrl });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await c1.query('UPDATE core.organisation SET slug = $2 WHERE id = $1', [a.org, target]);
      const second = c2.query('UPDATE core.manager_workspace SET subdomain = $2 WHERE id = $1', [b.id, target]);
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const r2 = await refusalOf(second);
      expect(r2.code).toMatch(/^(23505|23P01)$/);
      await c2.query('ROLLBACK');
    } finally {
      await c1.end();
      await c2.end();
    }
    expect((await admin.query(`SELECT count(DISTINCT organisation_id)::int AS n FROM core.host_label_claim WHERE label = $1`, [target])).rows[0].n).toBe(1);
  });

  it('rename quarantines the old label: other workspaces (any org) are refused, the releaser may reclaim; resolvers redirect', async () => {
    const w = await seed('qa');
    expect(await provisionServerPath(appUrl, w)).toBe('READY');
    const other = await seed('qb');
    const sibling = await seedSibling(w, 'qc');
    const old = w.label;
    const fresh = L('qa-new');

    await rename(w, fresh);
    const rel = (await admin.query('SELECT * FROM core.released_host_label WHERE label = $1', [old])).rows;
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ workspace_id: w.id, organisation_id: w.org, reason: 'RENAMED', released_by: w.owner, reclaimed_at: null });
    const days = (new Date(rel[0].reserved_until).getTime() - new Date(rel[0].released_at).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);

    expect(await refusalOf(rename(other, old))).toEqual({ code: '23505', constraint: 'host_label_unavailable' });
    expect(await refusalOf(rename(sibling, old))).toEqual({ code: '23505', constraint: 'host_label_unavailable' });
    expect(await refusalOf(admin.query('UPDATE core.organisation SET slug = $2 WHERE id = $1', [other.org, old]))).toEqual({
      code: '23505',
      constraint: 'host_label_unavailable',
    });
    expect(await status(old, other.id)).toBe('TAKEN');
    expect(await status(old, w.id)).toBe('AVAILABLE');
    expect((await app.query('SELECT core.workspace_subdomain_taken($1, $2) AS t', [old, other.id])).rows[0].t).toBe(true);

    // Pre-auth lookups: the new label routes; the old one resolves to the canonical label for a redirect.
    // display_name (workspace name, HostLabelResolverDisplayName1786719830000) is the stored name, unchanged by a rename.
    expect(await resolve(fresh)).toEqual([{ workspace_id: w.id, organisation_id: w.org, status: 'READY', canonical_label: fresh, display_name: old }]);
    expect(await resolve(old)).toEqual([]);
    expect(await resolveReleased(old)).toEqual([
      { workspace_id: w.id, organisation_id: w.org, canonical_label: fresh, reserved_until: rel[0].reserved_until },
    ]);

    // The releasing workspace reclaims its old label: allowed, the quarantine row is stamped, the redirect stops.
    await rename(w, old);
    expect((await admin.query('SELECT reclaimed_at FROM core.released_host_label WHERE id = $1', [rel[0].id])).rows[0].reclaimed_at).not.toBeNull();
    expect(await resolveReleased(old)).toEqual([]);
    expect(await resolve(old)).toEqual([expect.objectContaining({ workspace_id: w.id, canonical_label: old })]);
    // …and the label it just left (fresh) is now quarantined in turn.
    expect(await refusalOf(rename(other, fresh))).toEqual({ code: '23505', constraint: 'host_label_unavailable' });
  });

  it('an expired quarantine no longer blocks; a deleted workspace quarantines its label for everyone', async () => {
    const a = await seed('exp-a');
    const b = await seed('exp-b');
    const lapsed = L('lapsed');
    await admin.query(
      `INSERT INTO core.released_host_label (label, workspace_id, organisation_id, released_at, reserved_until, reason)
       VALUES ($1, $2, $3, now() - interval '100 days', now() - interval '10 days', 'RENAMED')`,
      [lapsed, a.id, a.org],
    );
    expect(await status(lapsed, b.id)).toBe('AVAILABLE');
    expect(await sqlstateOf(rename(b, lapsed))).toBe('ACCEPTED');

    const d = await seed('del');
    await admin.query('UPDATE core.organisation SET slug = $2 WHERE id = $1', [d.org, L('del-org')]);
    await admin.query('DELETE FROM core.manager_workspace WHERE id = $1', [d.id]);
    expect((await admin.query(`SELECT reason FROM core.released_host_label WHERE label = $1`, [d.label])).rows).toEqual([{ reason: 'WORKSPACE_DELETED' }]);
    expect(await refusalOf(rename(a, d.label))).toEqual({ code: '23505', constraint: 'host_label_unavailable' });
    expect(await resolveReleased(d.label)).toEqual([]); // nothing to redirect to
  });

  it('the pre-auth resolver returns an identical empty result for unknown, reserved, non-READY and suspended workspaces', async () => {
    const ready = await seed('rs-ready');
    expect(await provisionServerPath(appUrl, ready)).toBe('READY');
    const creating = await seed('rs-creating');
    const suspended = await seed('rs-susp');
    expect(await provisionServerPath(appUrl, suspended)).toBe('READY');
    await admin.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = 'test' WHERE id = $1`, [
      suspended.org,
      suspended.owner,
    ]);
    expect(await resolve(ready.label)).toHaveLength(1);
    expect(await resolve(`  ${ready.label.toUpperCase()} `)).toEqual(await resolve(ready.label)); // case/whitespace-insensitive
    for (const l of [L('unknown'), creating.label, suspended.label, 'admin', 'xn--abc', '', 'a', `${ready.label}.evil`, "x'; select 1; --"]) {
      expect(await resolve(l)).toEqual([]);
    }
    expect(await status('')).toBe('INVALID');
    expect(await status('support')).toBe('RESERVED');
    expect(await status(L('free-label'))).toBe('AVAILABLE');
    expect(await status(ready.label)).toBe('TAKEN');
    expect(await status(ready.label, ready.id)).toBe('AVAILABLE');
    expect((await app.query('SELECT core.host_label_is_reserved($1) AS r', ['XN--Abc'])).rows[0].r).toBe(true);
    expect((await app.query('SELECT core.host_label_quarantine_interval()::text AS i')).rows[0].i).toBe('90 days');
  });

  it('organisation_slug_taken now sees the workspace namespace and quarantines (resolveUniqueSlug auto-suffixes)', async () => {
    const a = await seed('slug-a');
    const NIL = '00000000-0000-0000-0000-000000000000';
    expect((await app.query('SELECT core.organisation_slug_taken($1, $2) AS t', [a.label, NIL])).rows[0].t).toBe(true);
    expect((await app.query('SELECT core.organisation_slug_taken($1, $2) AS t', [a.label, a.org])).rows[0].t).toBe(false);
    // Reserved labels stay allowed as (non-routable) organisation slugs: the bootstrap slug must keep working.
    expect((await app.query('SELECT core.organisation_slug_taken($1, $2) AS t', ['platform-' + sfx, NIL])).rows[0].t).toBe(false);
  });

  it('the runtime role has no privilege on the namespace tables; quarantine rows are never deleted, even by the superuser', async () => {
    for (const t of ['core.host_label_claim', 'core.released_host_label', 'core.reserved_host_label']) {
      expect(await sqlstateOf(app.query(`SELECT count(*) FROM ${t}`))).toBe('42501');
      expect(await sqlstateOf(app.query(`DELETE FROM ${t}`))).toBe('42501');
    }
    const crewflow = new Client({ connectionString: adminUrl });
    await crewflow.connect();
    try {
      await crewflow.query('SET ROLE crewflow');
      expect(await sqlstateOf(crewflow.query('SELECT count(*) FROM core.released_host_label'))).toBe('42501');
      // FORCE RLS: the owner of the claim registry sees zero rows with no tenant context bound (fail closed).
      await crewflow.query('BEGIN');
      await crewflow.query(`SELECT set_config('rab.organisation_id', '', true)`);
      expect((await crewflow.query('SELECT count(*)::int AS n FROM core.host_label_claim')).rows[0].n).toBe(0);
      await crewflow.query('ROLLBACK');
      expect(await sqlstateOf(crewflow.query(`SELECT * FROM core.resolve_workspace_by_host_label('x')`))).toBe('42501');
    } finally {
      await crewflow.end();
    }
    expect(await sqlstateOf(admin.query('DELETE FROM core.released_host_label'))).toBe('42501');
    expect(await sqlstateOf(admin.query(`UPDATE core.released_host_label SET reserved_until = now() WHERE true`))).toBe('42501');
    expect(await sqlstateOf(admin.query('TRUNCATE core.released_host_label'))).toBe('42501');
    // The functions' PUBLIC grant is revoked (a role with no grant cannot call them).
    const { rows } = await admin.query(
      `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace AND p.proname LIKE '%host_label%'
          AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))`,
    );
    expect(rows).toEqual([]);
  });
});
