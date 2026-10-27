import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { EntityManager } from 'typeorm';

import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AiQuotaUnavailableError } from '../../modules/ai/exceptions/ai.exceptions';
import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { AiCostMeterService } from '../../modules/ai/services/ai-cost-meter.service';
import { utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiUsageLedgerService } from '../../modules/ai/services/ai-usage-ledger.service';
import { AiUsageSettingsService, usageDailyDays, usagePeriodRange, zeroFilledDaily } from '../../modules/ai/services/ai-usage-settings.service';
import { TEST_MOCK_MODEL_ID } from '../support/ai/test-catalogue';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, manager, newConversation } from './helpers/ai-test-kit';
import { TestIdentity } from './helpers/test-identities';

/**
 * T7-U3 (PHASE7_TWENTY_PLAN §5): `GET /rest/v1/ai/settings/usage?period=today|month` on the real AppModule — five layers:
 * PermissionGuard(ai.settings) → service (flag re-read, CEO, both switches, Inspect refused, audited) → org-scoped query →
 * RLS → own-or-CEO predicate. Without the flag the uniform 404; the flag without being CEO 404; Inspect refused; `organisationId` in
 * the query 400; exactly the `AiUsageView` keys and no content anywhere.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const USAGE = '/rest/v1/ai/settings/usage';
const QUESTION = 'USAGE-CONTENT-CANARY how many offers are awaiting replies?';

describeIfDb('Settings → AI → Usage (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let tenant: TenantContextService;
  let ledger: AiUsageLedgerService;
  const day = utcDay();
  type Who = Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>;
  const write = (who: Who, over: { costUsdMicros: number; model?: string; turnId?: string; usageDate?: string }) =>
    tenant.runInTenantContext({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' }, (m: EntityManager) =>
      ledger.insertTerminal(m, {
        organisationId: who.organisationId,
        userId: who.userId,
        turnId: over.turnId ?? randomUUID(),
        usageDate: over.usageDate ?? day,
        kind: 'chat',
        model: over.model ?? TEST_MOCK_MODEL_ID,
        steps: 1,
        inputTokens: 1_000,
        cachedInputTokens: 600,
        cacheWriteTokens: 50,
        outputTokens: 40,
        costUsdMicros: over.costUsdMicros,
        outcome: 'completed',
      }),
    );

  beforeAll(async () => {
    kit = await bootAiKit();
    tenant = kit.moduleRef.get(TenantContextService);
    ledger = kit.moduleRef.get(AiUsageLedgerService);
  });
  afterAll(async () => {
    await kit?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('period ranges: today = [today, today]; month = [1st of the UTC month, today]', () => {
    const at = new Date('2026-10-25T23:30:00Z');
    expect(usagePeriodRange('today', at)).toEqual({ from: '2026-10-25', to: '2026-10-25' });
    expect(usagePeriodRange('month', at)).toEqual({ from: '2026-10-01', to: '2026-10-25' });
  });

  it('the CEO gets exactly AiUsageView for the organisation (by user, by model, budgets, live meters); audited ai.usage_viewed; no content', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-view');
    const im = await manager(kit, org.orgId, { initial: true });
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, QUESTION);
    await write(org.ceo, { costUsdMicros: 3_000, turnId: turn.turnId });
    await write(im.id, { costUsdMicros: 7_000 });
    await write(im.id, { costUsdMicros: 1_000 });
    const foreign = await aiOrganisation(kit, 'ai-usage-view-b');
    await write(foreign.ceo, { costUsdMicros: 999_999 });

    const res = await kit.http().get(`${USAGE}?period=today`).set(bearer(org.token));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['budgets', 'byModel', 'byUser', 'daily', 'from', 'period', 'to', 'today', 'totals']);
    expect(res.body).toMatchObject({ period: 'today', from: day, to: day });
    expect(res.body.totals).toEqual({ turns: 3, inputTokens: 3_000, cachedInputTokens: 1_800, cacheWriteTokens: 150, outputTokens: 120, costUsdMicros: 11_000 });
    expect(res.body.byUser).toEqual([
      expect.objectContaining({ userId: im.id.userId, turns: 2, costUsdMicros: 8_000, userCostTodayMicros: 8_000, displayName: expect.any(String) }),
      expect.objectContaining({ userId: org.ceo.userId, turns: 1, costUsdMicros: 3_000, userCostTodayMicros: 3_000 }),
    ]);
    for (const u of res.body.byUser) expect(Object.keys(u).sort()).toEqual(['cacheWriteTokens', 'cachedInputTokens', 'costUsdMicros', 'displayName', 'inputTokens', 'outputTokens', 'turns', 'userCostTodayMicros', 'userId']);
    expect(res.body.byModel).toEqual([{ modelId: TEST_MOCK_MODEL_ID, label: 'Crewflow deterministic test model', turns: 3, inputTokens: 3_000, cachedInputTokens: 1_800, cacheWriteTokens: 150, outputTokens: 120, costUsdMicros: 11_000 }]);
    const meter = kit.moduleRef.get(AiCostMeterService);
    expect(res.body.budgets).toEqual({ orgDailyCostCeilingMicros: meter.orgCeilingMicros, userDailyCostCeilingMicros: meter.userCeilingMicros, orgDailyTokenBudget: kit.moduleRef.get(AiConfigService).orgDailyTokenBudget });
    expect(Object.keys(res.body.today).sort()).toEqual(['alerts', 'orgCostMicros', 'orgTokensUsedOrReserved']);
    expect(res.body.today.alerts).toEqual([]);
    // No content and nothing of the other organisation.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('USAGE-CONTENT-CANARY');
    expect(body).not.toContain(conversationId);
    expect(body).not.toContain(turn.turnId);
    expect(body).not.toContain(foreign.ceo.userId);
    expect(body).not.toContain('999999');
    const audit = await kit.owner.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.usage_viewed'`, [org.orgId]);
    expect(audit).toEqual([{ actor_user_id: org.ceo.userId, metadata: { period: 'today', from: day, to: day } }]);
    expect((await kit.http().get(`${USAGE}?period=month`).set(bearer(org.token))).body).toMatchObject({ period: 'month', from: `${day.slice(0, 8)}01`, to: day });
  });

  it('S8 day helpers: the last 14 UTC days including today, oldest first; zero-filled; rows outside are ignored', () => {
    const at = new Date('2026-03-02T23:59:00Z');
    const days = usageDailyDays(at);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-02-17');
    expect(days[13]).toBe('2026-03-02');
    expect(zeroFilledDaily(days, [{ day: '2026-03-01', turns: '2', input_tokens: '10', output_tokens: '3', cost_usd_micros: '42' }, { day: '2026-01-01', turns: '9', input_tokens: '9', output_tokens: '9', cost_usd_micros: '9' }])).toEqual(
      days.map((d) => (d === '2026-03-01' ? { day: d, turns: 2, inputTokens: 10, outputTokens: 3, costUsdMicros: 42 } : { day: d, turns: 0, inputTokens: 0, outputTokens: 0, costUsdMicros: 0 })),
    );
  });

  it('S8: `daily` = the organisation’s last 14 UTC days (zero-filled, exact micro-USD sums, no per-user content), for either period', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-daily');
    const im = await manager(kit, org.orgId, { initial: true });
    const days = usageDailyDays();
    const today = days[13]!;
    const threeAgo = days[10]!;
    const oldest = days[0]!;
    const outside = utcDay(new Date(Date.UTC(Number(oldest.slice(0, 4)), Number(oldest.slice(5, 7)) - 1, Number(oldest.slice(8, 10)) - 1)));
    await write(org.ceo, { costUsdMicros: 1_001, usageDate: today });
    await write(im.id, { costUsdMicros: 2_002, usageDate: today });
    await write(im.id, { costUsdMicros: 3_003, usageDate: threeAgo });
    await write(org.ceo, { costUsdMicros: 4_004, usageDate: oldest });
    await write(org.ceo, { costUsdMicros: 999_001, usageDate: outside }); // 15 days ago: not in the series
    const foreign = await aiOrganisation(kit, 'ai-usage-daily-b');
    await write(foreign.ceo, { costUsdMicros: 888_888, usageDate: today });

    for (const period of ['today', 'month']) {
      const res = await kit.http().get(`${USAGE}?period=${period}`).set(bearer(org.token));
      expect(res.status).toBe(200);
      const daily = res.body.daily as Array<Record<string, unknown>>;
      expect(daily.map((p) => p.day)).toEqual(days);
      for (const p of daily) expect(Object.keys(p).sort()).toEqual(['costUsdMicros', 'day', 'inputTokens', 'outputTokens', 'turns']);
      const at = (d: string) => daily.find((p) => p.day === d)!;
      expect(at(today)).toEqual({ day: today, turns: 2, inputTokens: 2_000, outputTokens: 80, costUsdMicros: 3_003 });
      expect(at(threeAgo)).toEqual({ day: threeAgo, turns: 1, inputTokens: 1_000, outputTokens: 40, costUsdMicros: 3_003 });
      expect(at(oldest)).toEqual({ day: oldest, turns: 1, inputTokens: 1_000, outputTokens: 40, costUsdMicros: 4_004 });
      expect(daily.filter((p) => p.turns === 0)).toHaveLength(11);
      for (const p of daily) expect(Number.isInteger(p.costUsdMicros)).toBe(true);
      const series = JSON.stringify(daily);
      expect(series).not.toContain(im.id.userId);
      expect(series).not.toContain(org.ceo.userId);
      expect(series).not.toContain('999001');
      expect(series).not.toContain('888888');
    }
  });

  it('S8 abuse: the daily series is CEO-only — a non-CEO with ai.settings and a user without it see no series', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-daily-abuse');
    await write(org.ceo, { costUsdMicros: 5_555 });
    const im = await manager(kit, org.orgId, { initial: true });
    const noFlag = await kit.http().get(`${USAGE}?period=today`).set(bearer(im.token));
    expect(noFlag.status).toBe(404);
    expect(JSON.stringify(noFlag.body)).not.toContain('5555');
    const other = await manager(kit, org.orgId);
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'grant' FROM core.permission WHERE key = 'ai.settings'`,
      [other.id.userId, org.orgId],
    );
    const res = await kit.http().get(`${USAGE}?period=month`).set(bearer(await kit.factory.login(other.id)));
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'AI_NOT_AVAILABLE' });
    expect(res.body).not.toHaveProperty('daily');
  });

  it('without ai.settings (the Initial Manager, who may use AI) ⇒ the uniform 404; nothing audited', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-noflag');
    const im = await manager(kit, org.orgId, { initial: true });
    expect((await kit.http().get(`${USAGE}?period=today`).set(bearer(im.token))).status).toBe(404);
    expect(await kit.owner.query(`SELECT 1 FROM core.audit_log WHERE organisation_id = $1 AND action = 'ai.usage_viewed'`, [org.orgId])).toEqual([]);
  });

  it('a NON-CEO granted ai.settings gets the uniform 404 (layer 2) — and RLS alone would show only their own rows (layer 5)', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-custom');
    const other = await manager(kit, org.orgId);
    await kit.owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'grant' FROM core.permission WHERE key = 'ai.settings'`,
      [other.id.userId, org.orgId],
    );
    const token = await kit.factory.login(other.id);
    const res = await kit.http().get(`${USAGE}?period=today`).set(bearer(token));
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'AI_NOT_AVAILABLE' });
    await write(org.ceo, { costUsdMicros: 5 });
    await write(other.id, { costUsdMicros: 6 });
    const visible = await tenant.runInTenantContext({ organisationId: org.orgId, workspaceId: other.id.workspaceId, userId: other.id.userId, role: '' }, (m) => m.query(`SELECT user_id FROM core.ai_usage`));
    expect(visible).toEqual([{ user_id: other.id.userId }]);
  });

  it('Admin Inspect is refused by the service; an AI-off organisation or the kill switch ⇒ 404', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-inspect');
    const svc = kit.moduleRef.get(AiUsageSettingsService);
    await expect(svc.view({ organisationId: org.orgId, workspaceId: org.ceo.workspaceId, userId: org.ceo.userId, role: '', inspectedBy: randomUUID(), sessionId: randomUUID() }, 'today')).rejects.toMatchObject({ status: 404 });
    const off = await aiOrganisation(kit, 'ai-usage-off', { aiEnabled: false });
    expect((await kit.http().get(`${USAGE}?period=today`).set(bearer(off.token))).status).toBe(404);
    jest.spyOn(kit.moduleRef.get(AiConfigService), 'enabled', 'get').mockReturnValue(false);
    expect((await kit.http().get(`${USAGE}?period=today`).set(bearer(org.token))).status).toBe(404);
  });

  it('organisationId (or any other parameter) in the query is a 400, never a hint; a bad or missing period is a 400', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-dto');
    const foreign = await aiOrganisation(kit, 'ai-usage-dto-b');
    for (const q of [`period=today&organisationId=${foreign.orgId}`, 'period=today&userId=x', 'period=year', '']) {
      const res = await kit.http().get(`${USAGE}?${q}`).set(bearer(org.token));
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
      expect(JSON.stringify(res.body)).not.toContain(foreign.ceo.userId);
    }
    expect(await kit.owner.query(`SELECT 1 FROM core.audit_log WHERE organisation_id IN ($1, $2) AND action = 'ai.usage_viewed'`, [org.orgId, foreign.orgId])).toEqual([]);
  });

  it('live meters unavailable (Redis down) ⇒ 503, nothing guessed', async () => {
    const org = await aiOrganisation(kit, 'ai-usage-redis');
    jest.spyOn(kit.moduleRef.get(AiCostMeterService), 'alerts').mockRejectedValue(new AiQuotaUnavailableError());
    const res = await kit.http().get(`${USAGE}?period=today`).set(bearer(org.token));
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 503, code: 'AI_SERVICE_UNAVAILABLE' });
  });
});
