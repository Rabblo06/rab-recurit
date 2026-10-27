import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { EntityManager } from 'typeorm';

import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AiUsageLedgerRow } from '../../modules/ai/contracts/usage';
import { AiQuotaUnavailableError } from '../../modules/ai/exceptions/ai.exceptions';
import { AiCostMeterService } from '../../modules/ai/services/ai-cost-meter.service';
import { utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiUsageLedgerRowError, AiUsageLedgerService } from '../../modules/ai/services/ai-usage-ledger.service';
import { TEST_MOCK_MODEL_ID } from '../support/ai/test-catalogue';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, manager, newConversation } from './helpers/ai-test-kit';
import { TestIdentity } from './helpers/test-identities';

/**
 * Phase 7a `core.ai_usage` ledger and M7-1 columns on the REAL database as crewflow_app (FORCE RLS) — mock models only.
 *   T7-U1 (ledger part) one row per turn id under a double insert; deleting the conversation leaves the ledger row AND
 *          the per-user meter seed unchanged (deleting a chat never hands budget back).
 *   T7-U2 RLS: no tenant context → 0 rows; a foreign organisation → 0; a non-CEO sees only own rows; the CEO sees the
 *          organisation; UPDATE / DELETE as crewflow_app → 42501; INSERT for another user → refused; user erasure cascades.
 *   Plus: the purge definer (400-day floor, bound organisation, count only), the M7-1 turn columns / codes / grants, and
 *          the admin summary's new columns.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const pgCode = (e: unknown) => (e as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (e as { code?: string })?.code;

describeIfDb('AI usage ledger + M7-1 columns (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let tenant: TenantContextService;
  let ledger: AiUsageLedgerService;
  let meter: AiCostMeterService;
  const day = utcDay();

  beforeAll(async () => {
    kit = await bootAiKit();
    tenant = kit.moduleRef.get(TenantContextService);
    ledger = kit.moduleRef.get(AiUsageLedgerService);
    meter = kit.moduleRef.get(AiCostMeterService);
  });
  afterAll(async () => {
    await kit?.close();
  });

  type Who = Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>;
  const asTenant = <T>(who: Who, fn: (m: EntityManager) => Promise<T>) =>
    tenant.runInTenantContext({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' }, fn);
  const sqlAs = <T>(who: Who, sql: string, params: unknown[] = []) => asTenant<T>(who, (m) => m.query(sql, params) as Promise<T>);
  const row = (who: Who, over: Partial<AiUsageLedgerRow> = {}): AiUsageLedgerRow => ({
    organisationId: who.organisationId,
    userId: who.userId,
    turnId: randomUUID(),
    usageDate: day,
    kind: 'chat',
    model: TEST_MOCK_MODEL_ID,
    steps: 2,
    inputTokens: 1_200,
    cachedInputTokens: 800,
    cacheWriteTokens: 100,
    outputTokens: 90,
    costUsdMicros: 4_321,
    outcome: 'completed',
    contextUsedTokens: 700,
    contextLimitTokens: 32_000,
    ...over,
  });
  const write = (who: Who, r: AiUsageLedgerRow) => asTenant(who, (m) => ledger.insertTerminal(m, r));

  it('T7-U1 one row per turn: a second insert of the same turn id writes nothing (idempotent), metadata only', async () => {
    const org = await aiOrganisation(kit, 'ai-ledger-once');
    const r = row(org.ceo);
    expect(await write(org.ceo, r)).toBe(true);
    expect(await write(org.ceo, { ...r, costUsdMicros: 999_999 })).toBe(false);
    const rows = await kit.owner.query(`SELECT * FROM core.ai_usage WHERE turn_id = $1`, [r.turnId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'chat', model: TEST_MOCK_MODEL_ID, steps: 2, input_tokens: '1200', cached_input_tokens: '800', cache_write_tokens: '100', output_tokens: '90', cost_usd_micros: '4321', context_used_tokens: '700', context_limit_tokens: '32000', outcome: 'completed' });
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['cache_write_tokens', 'cached_input_tokens', 'context_limit_tokens', 'context_used_tokens', 'cost_usd_micros', 'created_at', 'id', 'input_tokens', 'kind', 'model', 'organisation_id', 'outcome', 'output_tokens', 'steps', 'turn_id', 'usage_date', 'user_id'].sort(),
    );
  });

  it('T7-U1 deleting the conversation leaves the ledger row and the user-meter seed unchanged', async () => {
    const org = await aiOrganisation(kit, 'ai-ledger-delete');
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'How many offers are awaiting replies?');
    expect(turn.status).toBe(202);
    // What the 7b runner writes in the turn's terminal transaction (no FK to the turn).
    expect(await write(org.ceo, row(org.ceo, { turnId: turn.turnId, costUsdMicros: 250_000 }))).toBe(true);
    const seed = () => asTenant(org.ceo, (m) => ledger.userDayCostMicros(m, org.orgId, org.ceo.userId, day));
    expect(await seed()).toBe(250_000);
    expect((await kit.http().delete(`/rest/v1/ai/conversations/${conversationId}`).set(bearer(org.token))).status).toBeLessThan(300);
    expect(await kit.owner.query(`SELECT id FROM core.ai_message WHERE id = $1`, [turn.turnId])).toEqual([]);
    expect(await kit.owner.query(`SELECT turn_id, cost_usd_micros FROM core.ai_usage WHERE turn_id = $1`, [turn.turnId])).toEqual([{ turn_id: turn.turnId, cost_usd_micros: '250000' }]);
    expect(await seed()).toBe(250_000);
    // A lost user meter is re-seeded from the ledger: the spent quarter stays spent.
    await kit.redis.del(meter.meterKey(org.orgId, day), meter.userMeterKey(org.orgId, org.ceo.userId, day));
    expect(await meter.reserveSeeded(org.orgId, org.ceo.userId, day, 800_000, { org: async () => 0, user: seed })).toEqual({ admitted: false, kind: 'user' });
    expect(await meter.current(org.orgId, org.ceo.userId, day)).toEqual({ orgMicros: 0, userMicros: 250_000 });
    await kit.redis.del(meter.meterKey(org.orgId, day), meter.userMeterKey(org.orgId, org.ceo.userId, day));
  });

  it('the seed refuses (fail closed) when read outside the user’s own or the CEO’s context — RLS would hide rows and read low', async () => {
    const org = await aiOrganisation(kit, 'ai-ledger-seed');
    const im = await manager(kit, org.orgId, { initial: true });
    await write(im.id, row(im.id, { costUsdMicros: 700_000 }));
    // Own context and the CEO: the real figure.
    expect(await asTenant(im.id, (m) => ledger.userDayCostMicros(m, org.orgId, im.id.userId, day))).toBe(700_000);
    expect(await asTenant(org.ceo, (m) => ledger.userDayCostMicros(m, org.orgId, im.id.userId, day))).toBe(700_000);
    // Another non-CEO user, a foreign organisation, no context: refused, never 0.
    const other = await manager(kit, org.orgId);
    await expect(asTenant(other.id, (m) => ledger.userDayCostMicros(m, org.orgId, im.id.userId, day))).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    const foreign = await aiOrganisation(kit, 'ai-ledger-seed-b');
    await expect(asTenant(foreign.ceo, (m) => ledger.userDayCostMicros(m, org.orgId, im.id.userId, day))).rejects.toBeInstanceOf(AiQuotaUnavailableError);
    await expect(kit.runtime.transaction((m) => ledger.userDayCostMicros(m, org.orgId, im.id.userId, day))).rejects.toBeInstanceOf(AiQuotaUnavailableError);
  });

  it('a malformed row is refused before SQL; an agent row is refused while EX-3 is not approved', async () => {
    const org = await aiOrganisation(kit, 'ai-ledger-bad');
    for (const [field, over] of [
      ['kind', { kind: 'agent' }],
      ['kind', { kind: 'other' as never }],
      ['model', { model: 'Bad Model' }],
      ['outcome', { outcome: 'queued' as never }],
      ['costUsdMicros', { costUsdMicros: -1 }],
      ['inputTokens', { inputTokens: 1.5 }],
      ['steps', { steps: 40_000 }],
      ['usageDate', { usageDate: 'today' }],
      ['turnId', { turnId: 'nope' }],
      ['contextUsedTokens', { contextUsedTokens: -3 }],
    ] as Array<[string, Partial<AiUsageLedgerRow>]>) {
      await expect(write(org.ceo, row(org.ceo, over))).rejects.toEqual(new AiUsageLedgerRowError(field));
    }
    expect(await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_usage WHERE organisation_id = $1`, [org.orgId])).toEqual([{ n: 0 }]);
  });

  // ── T7-U2 RLS ───────────────────────────────────────────────────────────────────────────────────────────────────
  describe('T7-U2 RLS on core.ai_usage (crewflow_app)', () => {
    let a: Awaited<ReturnType<typeof aiOrganisation>>;
    let im: Awaited<ReturnType<typeof manager>>;
    let b: Awaited<ReturnType<typeof aiOrganisation>>;

    beforeAll(async () => {
      a = await aiOrganisation(kit, 'ai-ledger-rls-a');
      im = await manager(kit, a.orgId, { initial: true });
      b = await aiOrganisation(kit, 'ai-ledger-rls-b');
      await write(a.ceo, row(a.ceo));
      await write(im.id, row(im.id));
      await write(im.id, row(im.id));
      await write(b.ceo, row(b.ceo));
    });

    it('no tenant context ⇒ zero rows (although rows exist)', async () => {
      const [{ total }] = await kit.owner.query(`SELECT count(*)::int AS total FROM core.ai_usage`);
      expect(total).toBeGreaterThan(0);
      expect(await kit.runtime.query(`SELECT count(*)::int AS n FROM core.ai_usage`)).toEqual([{ n: 0 }]);
    });

    it('the CEO reads the whole organisation and nothing of another; a non-CEO reads only their own rows', async () => {
      const ceoRows = await sqlAs<Array<{ user_id: string }>>(a.ceo, `SELECT user_id FROM core.ai_usage`);
      expect(ceoRows.map((r) => r.user_id).sort()).toEqual([a.ceo.userId, im.id.userId, im.id.userId].sort());
      const imRows = await sqlAs<Array<{ user_id: string }>>(im.id, `SELECT user_id FROM core.ai_usage`);
      expect(imRows.map((r) => r.user_id)).toEqual([im.id.userId, im.id.userId]);
      expect(await sqlAs(b.ceo, `SELECT 1 FROM core.ai_usage WHERE organisation_id = $1`, [a.orgId])).toEqual([]);
      // Forging A's organisation in B's session: B's user is no CEO of A and owns no row there.
      expect(await sqlAs({ organisationId: a.orgId, workspaceId: b.ceo.workspaceId, userId: b.ceo.userId }, `SELECT 1 FROM core.ai_usage`)).toEqual([]);
    });

    it('insert-only: UPDATE / DELETE / TRUNCATE as crewflow_app → 42501, even by the CEO on own rows', async () => {
      for (const sql of [`UPDATE core.ai_usage SET cost_usd_micros = 0`, `DELETE FROM core.ai_usage`, `TRUNCATE core.ai_usage`]) {
        expect({ sql, code: pgCode(await sqlAs(a.ceo, sql).catch((e) => e)) }).toEqual({ sql, code: '42501' });
      }
    });

    it('WITH CHECK: no row for another user (not even by the CEO) or another organisation; id / created_at are not insertable', async () => {
      const cols = `organisation_id, user_id, turn_id, usage_date, kind, model, outcome`;
      const vals = (org: string, user: string) => [org, user, randomUUID(), day, 'chat', TEST_MOCK_MODEL_ID, 'completed'];
      expect(pgCode(await sqlAs(a.ceo, `INSERT INTO core.ai_usage (${cols}) VALUES ($1, $2, $3, $4::date, $5, $6, $7)`, vals(a.orgId, im.id.userId)).catch((e) => e))).toBe('42501');
      expect(pgCode(await sqlAs(a.ceo, `INSERT INTO core.ai_usage (${cols}) VALUES ($1, $2, $3, $4::date, $5, $6, $7)`, vals(b.orgId, a.ceo.userId)).catch((e) => e))).toBe('42501');
      expect(pgCode(await sqlAs(a.ceo, `INSERT INTO core.ai_usage (id, ${cols}) VALUES (gen_random_uuid(), $1, $2, $3, $4::date, $5, $6, $7)`, vals(a.orgId, a.ceo.userId)).catch((e) => e))).toBe('42501');
      expect(pgCode(await sqlAs(a.ceo, `INSERT INTO core.ai_usage (created_at, ${cols}) VALUES (now() - interval '900 days', $1, $2, $3, $4::date, $5, $6, $7)`, vals(a.orgId, a.ceo.userId)).catch((e) => e))).toBe('42501');
      // The ledger service itself refuses to write for someone else than the bound user (RLS, not the service, decides).
      expect(pgCode(await write(a.ceo, row(im.id)).catch((e) => e))).toBe('42501');
    });

    it('user erasure cascades to the usage rows (rule 3.8); the organisation rows of others stay', async () => {
      const gone = await manager(kit, a.orgId);
      await write(gone.id, row(gone.id));
      expect(await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_usage WHERE user_id = $1`, [gone.id.userId])).toEqual([{ n: 1 }]);
      await kit.owner.query(`DELETE FROM core.manager_profile WHERE user_id = $1`, [gone.id.userId]).catch(() => undefined);
      await kit.owner.query(`DELETE FROM core."user" WHERE id = $1`, [gone.id.userId]);
      expect(await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_usage WHERE user_id = $1`, [gone.id.userId])).toEqual([{ n: 0 }]);
      expect(await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_usage WHERE organisation_id = $1`, [a.orgId])).toEqual([{ n: 3 }]);
    });

    it('grants and FORCE as recorded by the migration (posture facts)', async () => {
      const [facts] = await kit.owner.query(
        `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner,
                has_table_privilege('crewflow_app', 'core.ai_usage', 'SELECT') AS sel, has_table_privilege('crewflow_app', 'core.ai_usage', 'DELETE') AS del,
                has_any_column_privilege('crewflow_app', 'core.ai_usage', 'UPDATE') AS upd
           FROM pg_class c WHERE c.oid = 'core.ai_usage'::regclass`,
      );
      expect(facts).toEqual({ enabled: true, forced: true, owner: 'crewflow', sel: true, del: false, upd: false });
    });
  });

  it('retention purge: 400-day floor in SQL, the bound organisation only, count returned; nothing without context', async () => {
    const org = await aiOrganisation(kit, 'ai-ledger-purge');
    const other = await aiOrganisation(kit, 'ai-ledger-purge-b');
    const old = (o: typeof org, days: number) =>
      kit.owner.query(`INSERT INTO core.ai_usage (organisation_id, user_id, turn_id, usage_date, kind, model, outcome) VALUES ($1, $2, gen_random_uuid(), (now() - make_interval(days => $3))::date, 'chat', $4, 'completed')`, [o.orgId, o.ceo.userId, days, TEST_MOCK_MODEL_ID]);
    await old(org, 500);
    await old(org, 401);
    await old(org, 100);
    await old(other, 500);
    expect(pgCode(await sqlAs(org.ceo, `SELECT core.ai_usage_purge_expired(interval '399 days') AS n`).catch((e) => e))).toBe('22023');
    expect(pgCode(await sqlAs(org.ceo, `SELECT core.ai_usage_purge_expired(NULL) AS n`).catch((e) => e))).toBe('22023');
    expect(await kit.runtime.query(`SELECT core.ai_usage_purge_expired(interval '400 days') AS n`)).toEqual([{ n: 0 }]);
    expect(await sqlAs(org.ceo, `SELECT core.ai_usage_purge_expired(interval '400 days') AS n`)).toEqual([{ n: 2 }]);
    expect(await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_usage WHERE organisation_id = $1`, [org.orgId])).toEqual([{ n: 1 }]);
    expect(await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_usage WHERE organisation_id = $1`, [other.orgId])).toEqual([{ n: 1 }]);
    // The retention flag is no back door for the runtime role: it is not `crewflow` and holds no DELETE.
    const backDoor = asTenant(org.ceo, async (m) => {
      await m.query(`SELECT set_config('rab.ai_usage_retention', 'on', true)`);
      return m.query(`DELETE FROM core.ai_usage`);
    });
    expect(pgCode(await backDoor.catch((e) => e))).toBe('42501');
  });

  // ── M7-1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('M7-1: the turn row takes its cache split and cost (crewflow_app, own turn); negatives and unknown codes refuse; the two new codes are accepted', async () => {
    const org = await aiOrganisation(kit, 'ai-ledger-m71');
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'How many shifts are open?');
    await sqlAs(org.ceo, `UPDATE core.ai_message SET cached_input_tokens = 10, cache_write_tokens = 5, cost_usd_micros = 77 WHERE id = $1`, [turn.turnId]);
    expect(await kit.owner.query(`SELECT cached_input_tokens, cache_write_tokens, cost_usd_micros FROM core.ai_message WHERE id = $1`, [turn.turnId])).toEqual([{ cached_input_tokens: 10, cache_write_tokens: 5, cost_usd_micros: '77' }]);
    expect(pgCode(await kit.owner.query(`UPDATE core.ai_message SET cost_usd_micros = -1 WHERE id = $1`, [turn.turnId]).catch((e) => e))).toBe('23514');
    for (const code of ['AI_USER_BUDGET_EXHAUSTED', 'AI_CONTEXT_FULL']) await kit.owner.query(`UPDATE core.ai_message SET error_code = $2 WHERE id = $1`, [turn.turnId, code]);
    expect(pgCode(await kit.owner.query(`UPDATE core.ai_message SET error_code = 'AI_MADE_UP' WHERE id = $1`, [turn.turnId]).catch((e) => e))).toBe('23514');
    await kit.owner.query(`UPDATE core.ai_message SET error_code = NULL WHERE id = $1`, [turn.turnId]);
    // ai_usage_daily cache counters: updatable by the runtime role (the UPSERT), never negative.
    await sqlAs(org.ceo, `INSERT INTO core.ai_usage_daily (organisation_id, usage_date, model, cached_input_tokens, cache_write_tokens) VALUES ($1, $2::date, $3, 4, 2)
                          ON CONFLICT (organisation_id, usage_date, model) DO UPDATE SET cached_input_tokens = core.ai_usage_daily.cached_input_tokens + 4, cache_write_tokens = core.ai_usage_daily.cache_write_tokens + 2`, [org.orgId, day, TEST_MOCK_MODEL_ID]);
    expect(pgCode(await kit.owner.query(`UPDATE core.ai_usage_daily SET cached_input_tokens = -1 WHERE organisation_id = $1`, [org.orgId]).catch((e) => e))).toBe('23514');
  });

  it('M7-1: core.ai_admin_usage_summary returns the estimated cost and cache counters, still only for an active platform administrator', async () => {
    const org = await aiOrganisation(kit, 'ai-ledger-admin');
    await kit.owner.query(
      `INSERT INTO core.ai_usage_daily (organisation_id, usage_date, model, input_tokens, output_tokens, turns, cost_usd_micros, cached_input_tokens, cache_write_tokens) VALUES ($1, $2::date, $3, 100, 10, 1, 555, 60, 20)
       ON CONFLICT (organisation_id, usage_date, model) DO UPDATE SET cost_usd_micros = 555, cached_input_tokens = 60, cache_write_tokens = 20, turns = 1`,
      [org.orgId, day, TEST_MOCK_MODEL_ID],
    );
    expect(pgCode(await sqlAs(org.ceo, `SELECT * FROM core.ai_admin_usage_summary($1::date, $1::date, 200)`, [day]).catch((e) => e))).toBe('42501');
    const admin = await kit.factory.createCeo(await kit.factory.createOrganisation('ai-ledger-admin-pa'), { platformAdmin: true });
    const rows = await sqlAs<Array<Record<string, unknown>>>({ organisationId: admin.organisationId, workspaceId: null, userId: admin.userId }, `SELECT * FROM core.ai_admin_usage_summary($1::date, $1::date, 200)`, [day]);
    const mine = rows.find((r) => r.organisationId === org.orgId);
    expect(mine).toMatchObject({ costUsdMicros: '555', cachedInputTokens: '60', cacheWriteTokens: '20' });
    expect(Object.keys(mine!).sort()).toEqual(['aiEnabled', 'cacheWriteTokens', 'cachedInputTokens', 'cancelledTurns', 'costUsdMicros', 'failedTurns', 'inputTokens', 'organisationId', 'organisationName', 'outputTokens', 'toolCalls', 'turns'].sort());
  });
});
