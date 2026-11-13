import { DataSource } from 'typeorm';

import { TOKEN_CLEANUP_PREVIOUS_SQL } from '../../database/typeorm/core/migrations/1786721460000-TokenCleanupRotationOrder';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * XP-09 (TokenCleanupRotationOrder1786721460000): `core.worker_cleanup_auth_tokens` must never take a rotated successor into a
 * batch without its predecessor. Before the fix the batch was `LIMIT n` in heap order; once early heap pages had free space
 * (deletes + vacuum), a new successor was stored before its predecessor, the DELETE hit `refresh_token_replaced_by_fkey`
 * (23503) and every later run failed the same way (the cleanup stopped for good).
 *
 * The fixture rebuilds that heap layout on the real schema: filler tokens fill the first pages and are deleted + vacuumed,
 * then rotated pairs are created the application's way (INSERT successor, UPDATE predecessor SET revoked_at, replaced_by),
 * so successors land in the early pages, before their predecessors. The function is then run with small batches, exactly
 * as the Worker calls it (`SELECT … FROM core.worker_cleanup_auth_tokens($1)`), as the runtime login.
 *
 * Rows are tagged by token_hash prefix so other suites' rows on a shared test database are never asserted on; the cleanup is
 * table-wide by design (the Worker runs it that way), so every row it deletes is an eligible one.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const TAG = `xp09-${Date.now().toString(36)}`;

describeIfDb('token cleanup never splits a rotated chain across a batch (XP-09, integration)', () => {
  let admin: DataSource;
  let runtime: DataSource;
  let org: string;
  let user: string;

  const eligibleTagged = async (prefix: string) =>
    Number((await admin.query(
      `SELECT count(*)::int AS n FROM core.refresh_token WHERE token_hash LIKE $1
         AND ((revoked_at IS NOT NULL AND revoked_at < now() - interval '181 days') OR expires_at < now() - interval '181 days')`,
      [`${prefix}%`],
    ))[0].n);
  const dangling = async () =>
    Number((await admin.query(`SELECT count(*)::int AS n FROM core.refresh_token p LEFT JOIN core.refresh_token s ON s.id = p.replaced_by
                                WHERE p.replaced_by IS NOT NULL AND s.id IS NULL`))[0].n);
  const cleanup = (batch: number) =>
    runtime.query(`SELECT refresh_tokens_deleted, password_reset_tokens_deleted FROM core.worker_cleanup_auth_tokens($1::integer)`, [batch]);

  beforeAll(async () => {
    const t0 = Date.now();
    const step = (what: string) => process.stdout.write(`[xp09 setup] ${what} +${Date.now() - t0} ms
`);
    admin = createAdminDataSource();
    await admin.initialize();
    runtime = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL, synchronize: false, migrationsRun: false, entities: [] });
    await runtime.initialize();
    step('connections');
    // Anything already eligible on a shared test database goes first, so the batches below see this suite's rows.
    await cleanup(10000);
    step('drain');
    [{ id: org }] = await admin.query(`INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id`, [TAG, TAG]);
    [{ id: user }] = await admin.query(
      `INSERT INTO core."user" (organisation_id, email, first_name, last_name, status) VALUES ($1, $2, 'Xp', 'Nine', 'active') RETURNING id`,
      [org, `${TAG}@example.test`],
    );
    step('fixture');
  }, 300_000);

  afterAll(async () => {
    if (org) await admin.query(`DELETE FROM core.organisation WHERE id = $1`, [org]).catch(() => undefined);
    await runtime?.destroy();
    await admin?.destroy();
  });

  it('successors stored BEFORE their predecessors in the heap (the production layout after deletes + vacuum)', async () => {
    await admin.query(
      `INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, created_at, application_target, family_expires_at)
       SELECT $1, $2, $3 || '-f-' || g, gen_random_uuid(), now() + interval '30 days', now() - interval '1 day', 'staff_app', now() + interval '60 days'
         FROM generate_series(1, 2000) g`,
      [org, user, TAG],
    );
    await admin.query(
      `INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, created_at, application_target, family_expires_at)
       SELECT $1, $2, $3 || '-a-' || g, gen_random_uuid(), now() - interval '370 days', now() - interval '400 days' + make_interval(secs => g), 'staff_app', now() - interval '310 days'
         FROM generate_series(1, 400) g`,
      [org, user, TAG],
    );
    await admin.query(`DELETE FROM core.refresh_token WHERE token_hash LIKE $1`, [`${TAG}-f-%`]);
    await admin.query(`VACUUM core.refresh_token`);
    // The application's rotation order: INSERT the successor, then UPDATE the predecessor.
    await admin.query(
      `DO $$
       DECLARE a record; b uuid;
       BEGIN
         FOR a IN SELECT id, organisation_id, user_id, family_id, created_at, family_expires_at FROM core.refresh_token
                   WHERE token_hash LIKE '${TAG}-a-%' ORDER BY created_at, id LOOP
           INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, created_at, application_target, family_expires_at)
           VALUES (a.organisation_id, a.user_id, '${TAG}-b-' || a.id, a.family_id, a.created_at + interval '31 days', a.created_at + interval '1 hour', 'staff_app', a.family_expires_at)
           RETURNING id INTO b;
           UPDATE core.refresh_token SET revoked_at = a.created_at + interval '1 hour', replaced_by = b WHERE id = a.id;
         END LOOP;
       END $$`,
    );
    const [layout] = await admin.query(
      `SELECT count(*)::int AS successor_first FROM core.refresh_token s JOIN core.refresh_token p ON p.replaced_by = s.id
        WHERE p.token_hash LIKE $1 AND s.ctid < p.ctid`,
      [`${TAG}-a-%`],
    );
    expect(layout.successor_first).toBeGreaterThan(0); // the layout that broke the old body
    expect(await eligibleTagged(TAG)).toBe(800);

    // Negative control: the previous body (WebSessionRetention1786717100000), installed inside a transaction that is rolled
    // back, fails on this exact layout with the FK error — so the assertions below can fail.
    const qr = admin.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(TOKEN_CLEANUP_PREVIOUS_SQL);
      await expect(qr.query(`SELECT * FROM core.worker_cleanup_auth_tokens(37)`)).rejects.toMatchObject({ code: '23503' });
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }

    let runs = 0;
    while ((await eligibleTagged(TAG)) > 0 && runs < 40) {
      const [r] = await cleanup(37); // an odd batch size, so boundaries fall inside chains
      expect(r.refresh_tokens_deleted).toBeGreaterThan(0);
      expect(await dangling()).toBe(0);
      runs++;
    }
    expect(await eligibleTagged(TAG)).toBe(0);
    expect(runs).toBe(Math.ceil(800 / 37));
  });

  it('safety net: a row still referenced by a row that is NOT eligible is kept (with its successors), never a 23503', async () => {
    // Not produced by the application (it revokes the predecessor before the successor exists); data that violates the
    // ordering must still never make the cleanup fail.
    const [{ c }] = await admin.query(
      `INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, created_at, application_target, family_expires_at)
       VALUES ($1, $2, $3 || '-nc', gen_random_uuid(), now() - interval '300 days', now() - interval '340 days', 'staff_app', now() - interval '300 days') RETURNING id AS c`,
      [org, user, TAG],
    );
    const [{ b }] = await admin.query(
      `INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by, created_at, application_target, family_expires_at)
       VALUES ($1, $2, $3 || '-nb', gen_random_uuid(), now() - interval '330 days', now() - interval '340 days', $4, now() - interval '360 days', 'staff_app', now() - interval '300 days') RETURNING id AS b`,
      [org, user, TAG, c],
    );
    await admin.query(
      `INSERT INTO core.refresh_token (organisation_id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by, created_at, application_target, family_expires_at)
       VALUES ($1, $2, $3 || '-na', gen_random_uuid(), now() + interval '20 days', now() - interval '1 day', $4, now() - interval '370 days', 'staff_app', now() + interval '20 days')`,
      [org, user, TAG, b],
    );
    for (let i = 0; i < 3; i++) await cleanup(1000);
    const left = await admin.query(`SELECT token_hash FROM core.refresh_token WHERE token_hash LIKE $1 ORDER BY token_hash`, [`${TAG}-n%`]);
    expect(left.map((r: { token_hash: string }) => r.token_hash)).toEqual([`${TAG}-na`, `${TAG}-nb`, `${TAG}-nc`]);
    expect(await dangling()).toBe(0);
    // Once the predecessor goes (here: revoked long ago), the whole chain is deleted in one run.
    await admin.query(`UPDATE core.refresh_token SET revoked_at = now() - interval '200 days' WHERE token_hash = $1`, [`${TAG}-na`]);
    await cleanup(1000);
    expect(await admin.query(`SELECT 1 FROM core.refresh_token WHERE token_hash LIKE $1`, [`${TAG}-n%`])).toHaveLength(0);
  });

  it('unchanged contract: owner rab_secure_owner, SECURITY DEFINER, pinned search_path, batch clamped to 1..10000', async () => {
    const [f] = await admin.query(
      `SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig FROM pg_proc WHERE oid = 'core.worker_cleanup_auth_tokens(integer)'::regprocedure`,
    );
    expect(f).toMatchObject({ owner: 'rab_secure_owner', prosecdef: true, proconfig: ['search_path=pg_catalog, core, pg_temp'] });
    const [zero] = await cleanup(0);
    expect(zero).toMatchObject({ refresh_tokens_deleted: expect.any(Number), password_reset_tokens_deleted: expect.any(Number) });
  });
});
