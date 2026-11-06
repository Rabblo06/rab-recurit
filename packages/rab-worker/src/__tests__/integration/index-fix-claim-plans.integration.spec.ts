import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

/**
 * Index fix (owner-approved 2026-11-06; OutboxClaimIndexes1786721440000, RefreshTokenReplacedByIndex1786721450000): EXPLAIN
 * regression tests for the per-scope dispatch claims and the token-cleanup delete, planned as the RUNTIME LOGIN.
 *
 * How the runtime plans are reproduced: the test cluster's superuser (TEST_DATABASE_URL_UNPOOLED) seeds synthetic rows in ONE
 * transaction that is always rolled back (nothing is committed, so no other suite or dispatcher ever sees them), ANALYZEs
 * the tables inside it, then `SET LOCAL ROLE crewflow_owner` — the one login the API and the Worker connect as — and binds
 * exactly the transaction-local GUCs TenantContextService binds (rab.organisation_id / workspace_id / user_id / role /
 * actor_type, search_path core). crewflow_owner is not BYPASSRLS and every table here is FORCE RLS, so the plans carry the
 * production RLS predicates. The definer-internal token delete is planned as its owner, rab_secure_owner.
 *
 * The realtime claim is not covered: its index was deferred (owner decision 2026-11-06; it needs a claim-SQL change first).
 *
 * Asserted on SHAPE only (the expected index, no sequential scan of the big table); timings are printed, never asserted,
 * except one generous bound on the replaced_by referential-check time (≈ 30× headroom over the indexed cost; without the
 * index the same delete takes seconds). Before the index fix every one of these failed: Seq Scan on the outbox for every
 * organisation, and a full refresh_token scan per deleted token.
 *
 * The claim SQL below is a COPY of the Worker's per-scope claim predicates; the first test proves the copies still occur
 * verbatim (whitespace-normalised) in the Worker source, so a claim edit that is not mirrored here fails loudly.
 */
const RUN = Boolean(process.env.DATABASE_URL && process.env.TEST_DATABASE_URL_UNPOOLED);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(300_000);

const ORGS = 40;
const ROWS = 60_000; // per outbox table: ~0.5 % claimable, the rest terminal
const TOKENS = 60_000;

const EMAIL_PREDICATE = `WHERE status = 'PENDING'
             OR (status = 'QUEUED' AND queued_at < now() - interval '2 minutes')
             OR (status = 'PROCESSING' AND processing_at < now() - interval '\${PROCESSING_LEASE_MINUTES} minutes')
             OR (status = 'RETRY' AND updated_at < now() - interval '\${RETRY_STALE_MINUTES} minutes')
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`;
const PUSH_PREDICATE = `WHERE status = 'PENDING'
             OR (status = 'PROCESSING' AND processing_at < now() - interval '\${PROCESSING_LEASE_MINUTES} minutes')
             OR (status = 'RETRY' AND updated_at < now() - interval '\${RETRY_STALE_MINUTES} minutes')
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`;

/** The Worker's constants (email-dispatch.job.ts / push-dispatch.job.ts): PROCESSING lease 10 min, RETRY stale 5 min. */
const expand = (sql: string) => sql.replace('${PROCESSING_LEASE_MINUTES}', '10').replace('${RETRY_STALE_MINUTES}', '5');
const EMAIL_CLAIM = `SELECT id, organisation_id, status, infrastructure_attempt_count, max_infrastructure_attempts, provider_call_started_at, dispatch_generation
  FROM core.email_outbox ${expand(EMAIL_PREDICATE)}`;
const PUSH_CLAIM = `SELECT id, organisation_id, status, attempt_count, max_attempts, provider_call_started_at, dispatch_generation, queued_at
  FROM core.push_delivery ${expand(PUSH_PREDICATE)}`;

/** An Index Scan, Index Only Scan or Bitmap Index Scan on the index: which one the planner picks depends on how many rows are claimable. */
const usesIndex = (name: string) => new RegExp(`(Index Scan( Backward)? using|Index Only Scan using|Bitmap Index Scan on) ${name}( |$)`, 'm');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const source = (rel: string) => squash(readFileSync(join(__dirname, '..', '..', rel), 'utf8'));
const org = (n: number) => `1d000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

describeIfDb('index fix: claim and token-cleanup plans as the runtime login (EXPLAIN regression)', () => {
  let admin: Client;
  const plans: Record<string, string> = {};

  const explain = async (label: string, sql: string, params: unknown[] = []): Promise<string> => {
    await admin.query('SAVEPOINT plan');
    try {
      const { rows } = await admin.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
      plans[label] = rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
    } finally {
      await admin.query('ROLLBACK TO SAVEPOINT plan');
    }
    // eslint-disable-next-line no-console
    console.log(`--- ${label}\n${plans[label]}`);
    return plans[label]!;
  };

  /** TenantContextService.bindGucs, as the runtime login (transaction-local). */
  const asRuntime = async (organisationId: string, workspaceId: string | null) => {
    await admin.query('SET LOCAL ROLE crewflow_owner');
    await admin.query(
      `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', '', true),
              set_config('rab.role', '', true), set_config('rab.actor_type', 'worker', true), set_config('rab.team_shift_id', '', true),
              set_config('rab.team_staff_id', '', true), set_config('rab.admin_scope', '', true), set_config('search_path', 'core', true)`,
      [organisationId, workspaceId ?? ''],
    );
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL_UNPOOLED! });
    await admin.connect();
    await admin.query('BEGIN');
    // Synthetic rows only, never committed. Replica mode skips the FK / trigger checks of the synthetic parents (superuser).
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(
      `INSERT INTO core.organisation (id, name, slug) SELECT ('1d000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'idx-' || g, 'idx-fix-' || g
         FROM generate_series(1, $1) g`,
      [ORGS],
    );
    // org(g): 40 % of the rows in organisation 1 (the skewed tenant), the rest spread over 2..ORGS.
    const orgOf = `('1d000000-0000-4000-8000-' || lpad(to_hex(CASE WHEN g % 5 < 2 THEN 1 ELSE 2 + g % ${ORGS - 1} END), 12, '0'))::uuid`;
    const ago = `now() - make_interval(mins => g % 100000)`;
    await admin.query(
      `INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, rendered_subject, created_at, updated_at, sent_at, queued_at, processing_at)
       SELECT ${orgOf}, 'NOTIFICATION',
              CASE g % 200 WHEN 0 THEN 'PENDING' WHEN 1 THEN 'QUEUED' WHEN 2 THEN 'RETRY' WHEN 3 THEN 'PROCESSING' ELSE 'SENT' END,
              'idx' || g || '@example.test', 's', ${ago}, ${ago}, CASE WHEN g % 200 > 3 THEN ${ago} END,
              CASE WHEN g % 200 IN (1, 3) THEN ${ago} END, CASE WHEN g % 200 = 3 THEN ${ago} END
         FROM generate_series(1, $1) g`,
      [ROWS],
    );
    await admin.query(
      `INSERT INTO core.push_delivery (organisation_id, notification_id, push_device_id, status, created_at, updated_at, accepted_at, processing_at)
       SELECT ${orgOf}, gen_random_uuid(), gen_random_uuid(),
              CASE g % 200 WHEN 0 THEN 'PENDING' WHEN 1 THEN 'RETRY' WHEN 2 THEN 'PROCESSING' ELSE 'ACCEPTED' END,
              ${ago}, ${ago}, CASE WHEN g % 200 > 2 THEN ${ago} END, CASE WHEN g % 200 = 2 THEN ${ago} END
         FROM generate_series(1, $1) g`,
      [ROWS],
    );
    // Refresh tokens: 1 in 3 rotated long ago (revoked + expired past the 181-day retention, replaced_by → its successor, the
    // next token); successors stay live, so the cleanup's delete never removes a still-referenced row.
    await admin.query(
      `CREATE TEMP TABLE idx_tok ON COMMIT DROP AS SELECT g, gen_random_uuid() AS id FROM generate_series(1, $1) g`,
      [TOKENS],
    );
    await admin.query(
      `INSERT INTO core.refresh_token (id, organisation_id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by, created_at,
                                       application_target, family_expires_at)
       SELECT t.id, ${orgOf.replace(/\bg\b/g, 't.g')}, gen_random_uuid(), 'idx-fix-' || md5(t.id::text), gen_random_uuid(),
              CASE WHEN t.g % 3 = 0 THEN now() - interval '399 days' ELSE now() + interval '1 day' END,
              CASE WHEN t.g % 3 = 0 THEN now() - interval '300 days' END,
              CASE WHEN t.g % 3 = 0 THEN n.id END,
              now() - interval '401 days', 'staff_app', now() + interval '1 day'
         FROM idx_tok t LEFT JOIN idx_tok n ON n.g = t.g + 1`,
    );
    await admin.query(`SET LOCAL session_replication_role = origin`);
    for (const t of ['email_outbox', 'push_delivery', 'refresh_token']) await admin.query(`ANALYZE core.${t}`);
  });

  afterAll(async () => {
    await admin?.query('ROLLBACK').catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it('the copied claim predicates still occur verbatim in the Worker source', () => {
    expect(source('queues/rab-email/email-dispatch.job.ts')).toContain(squash(EMAIL_PREDICATE));
    expect(source('queues/rab-push/push-dispatch.job.ts')).toContain(squash(PUSH_PREDICATE));
  });

  it('the new indexes exist and are VALID', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, i.indisvalid AND i.indisready AS ok FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relnamespace = 'core'::regnamespace AND c.relname = ANY($1) ORDER BY 1`,
      [['email_outbox_claim_idx', 'push_delivery_claim_idx', 'refresh_token_replaced_by_idx', 'login_history_user_id_idx']],
    );
    expect(rows).toEqual(
      ['email_outbox_claim_idx', 'login_history_user_id_idx', 'push_delivery_claim_idx', 'refresh_token_replaced_by_idx'].map((relname) => ({ relname, ok: true })),
    );
  });

  it.each([
    ['skewed organisation', 1],
    ['small organisation', 7],
  ])('email claim (%s): email_outbox_claim_idx, no sequential scan of the outbox', async (_label, n) => {
    await admin.query('SAVEPOINT ctx');
    await asRuntime(org(n), null);
    const plan = await explain(`email claim org ${n}`, EMAIL_CLAIM, [50]);
    await admin.query('ROLLBACK TO SAVEPOINT ctx');
    expect(plan).toMatch(usesIndex('email_outbox_claim_idx'));
    expect(plan).not.toMatch(/Seq Scan on email_outbox/);
  });

  it.each([
    ['skewed organisation', 1],
    ['small organisation', 7],
  ])('push claim (%s): push_delivery_claim_idx, no sequential scan', async (_label, n) => {
    await admin.query('SAVEPOINT ctx');
    await asRuntime(org(n), null);
    const plan = await explain(`push claim org ${n}`, PUSH_CLAIM, [50]);
    await admin.query('ROLLBACK TO SAVEPOINT ctx');
    expect(plan).toMatch(usesIndex('push_delivery_claim_idx'));
    expect(plan).not.toMatch(/Seq Scan on push_delivery/);
  });

  it('token cleanup (worker_cleanup_auth_tokens delete, as rab_secure_owner): the replaced_by referential check is an index probe', async () => {
    await admin.query('SAVEPOINT ctx');
    await admin.query('SET LOCAL ROLE rab_secure_owner');
    // The referential check PostgreSQL runs for each deleted row (RI_FKey_noaction_del): its plan must use the index.
    const probe = await explain('replaced_by RI probe', `SELECT 1 FROM ONLY core.refresh_token x WHERE replaced_by = $1 FOR KEY SHARE OF x`, [
      '00000000-0000-4000-8000-000000000000',
    ]);
    expect(probe).toMatch(/refresh_token_replaced_by_idx/);
    expect(probe).not.toMatch(/Seq Scan/);
    // The function's own delete (batch 1000): the RI trigger time stays far below a full-table scan per row.
    const plan = await explain(
      'token cleanup delete (1000)',
      `DELETE FROM core.refresh_token WHERE id IN (
         SELECT id FROM core.refresh_token
          WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '181 days') OR (expires_at < now() - interval '181 days')
          LIMIT 1000)`,
    );
    await admin.query('ROLLBACK TO SAVEPOINT ctx');
    const trigger = /Trigger for constraint refresh_token_replaced_by_fkey: time=([\d.]+) calls=(\d+)/.exec(plan);
    expect(trigger).not.toBeNull();
    expect(Number(trigger![2])).toBeGreaterThan(0);
    expect(Number(trigger![1])).toBeLessThan(1500);
  });

  it('user delete support: the login_history.user_id referential check is an index probe', async () => {
    await admin.query('SAVEPOINT ctx');
    const plan = await explain('login_history RI probe', `SELECT 1 FROM ONLY core.login_history x WHERE user_id = $1 FOR KEY SHARE OF x`, [
      '00000000-0000-4000-8000-000000000000',
    ]);
    await admin.query('ROLLBACK TO SAVEPOINT ctx');
    expect(plan).toMatch(/login_history_user_id_idx/);
  });
});
