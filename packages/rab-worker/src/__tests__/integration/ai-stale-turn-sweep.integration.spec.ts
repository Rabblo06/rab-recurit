// FIRST: env is frozen when a module reading it is imported. Own Redis DB index (11) for this suite.
const baseRedis = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.REDIS_URL = `${baseRedis.replace(/\/\d+$/, '')}/11`;
process.env.AI_ENABLED = 'true';
for (const retired of ['AI_PROVIDER', 'AI_MODEL', 'AI_PROVIDER_API_KEY'])
  process.env[retired] = '';

import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AI_STALE_SWEEP_USER_PAGE_SIZE, AiStaleTurnSweepService } from '@rab/server/modules/ai/services/ai-stale-turn-sweep.service';
import { AiTurnRunnerService } from '@rab/server/modules/ai/services/ai-turn-runner.service';
import { AiQuotaService } from '@rab/server/modules/ai/services/ai-quota.service';
import { ProcessorExplorer } from '../../core/scheduler/processor-explorer';
import { WorkerModule } from '../../worker.module';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
const MIN = 60_000;

/**
 * Phase D-Q2 — the AI stale-queued-turn sweep against real PostgreSQL (FORCE RLS, restricted runtime role) in the REAL
 * WorkerModule graph. Turns are seeded directly (admin connection) because their BullMQ job is, by definition, lost.
 * Owner rule: fail-and-user-retry only — a stale queued turn ends `failed` / AI_WORKER_INTERRUPTED, never re-run.
 */
describeIfDb('AI stale-turn sweep (D-Q2, integration)', () => {
  jest.setTimeout(180_000);
  let moduleRef: TestingModule;
  let admin: DataSource;
  let dataSource: DataSource;
  let sweep: AiStaleTurnSweepService;
  let runner: AiTurnRunnerService;
  let env: EnvironmentService;
  let factory: TestIdentityFactory;
  let flag: unknown = true;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    sweep = moduleRef.get(AiStaleTurnSweepService, { strict: false });
    runner = moduleRef.get(AiTurnRunnerService, { strict: false });
    env = moduleRef.get(EnvironmentService, { strict: false });
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app: moduleRef as never,
      dataSource,
      adminDataSource: admin,
      tenantContext: moduleRef.get(TenantContextService, { strict: false }),
      passwordHashing: moduleRef.get(PasswordHashingService, { strict: false }),
    });
    const realGet = env.get.bind(env) as (key: string) => unknown;
    jest
      .spyOn(env, 'get')
      .mockImplementation(((key: string) =>
        key === 'AI_STALE_TURN_SWEEP'
          ? flag
          : realGet(key)) as unknown as typeof env.get);
    // Every turn the earlier suites may have left queued in this shared database is pushed out of reach (age reset) so
    // counts below are about THIS suite's rows only.
    await admin.query(
      `UPDATE core.ai_message SET created_at = now() WHERE status = 'queued'`,
    );
  });
  afterEach(() => {
    flag = true;
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await admin?.destroy();
    await moduleRef?.close();
  });

  /** A conversation with one user message and one assistant turn in `status`, created `ageMs` ago. */
  async function seedTurn(
    owner: TestIdentity,
    status: 'queued' | 'running' | 'completed',
    ageMs: number,
    extra: { reserved?: number; conversationId?: string; seq?: number } = {},
  ) {
    const conversationId = extra.conversationId ?? randomUUID();
    if (!extra.conversationId) {
      await admin.query(
        `INSERT INTO core.ai_conversation (id, organisation_id, workspace_id, user_id, message_count) VALUES ($1, $2, $3, $4, 2)`,
        [conversationId, owner.organisationId, owner.workspaceId, owner.userId],
      );
    }
    const seq = extra.seq ?? 1;
    const userMessageId = randomUUID();
    const turnId = randomUUID();
    await admin.query(
      `INSERT INTO core.ai_message (id, organisation_id, workspace_id, user_id, conversation_id, seq, role, content, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'user', 'question', now() - ($7 || ' milliseconds')::interval, now() - ($7 || ' milliseconds')::interval)`,
      [
        userMessageId,
        owner.organisationId,
        owner.workspaceId,
        owner.userId,
        conversationId,
        seq,
        String(ageMs),
      ],
    );
    await admin.query(
      `INSERT INTO core.ai_message (id, organisation_id, workspace_id, user_id, conversation_id, seq, role, status, request_message_id, session_id, reserved_tokens,
                                    lease_token, lease_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'assistant', $7, $8, $9, $10, $11, $12, now() - ($13 || ' milliseconds')::interval, now() - ($13 || ' milliseconds')::interval)`,
      [
        turnId,
        owner.organisationId,
        owner.workspaceId,
        owner.userId,
        conversationId,
        seq + 1,
        status,
        userMessageId,
        randomUUID(),
        extra.reserved ?? 1000,
        status === 'running' ? randomUUID() : null,
        status === 'running' ? new Date(Date.now() + 60_000) : null,
        String(ageMs),
      ],
    );
    return { conversationId, turnId };
  }
  const turn = async (id: string) =>
    (
      await admin.query(
        `SELECT status, error_code, completed_at FROM core.ai_message WHERE id = $1`,
        [id],
      )
    )[0];
  const audits = async (id: string) =>
    admin.query<Array<{ action: string; metadata: Record<string, unknown> }>>(
      `SELECT action, metadata FROM core.audit_log WHERE entity_id = $1 ORDER BY created_at`,
      [id],
    );

  it('S0 the scan is registered on the maintenance queue in the real Worker graph', () => {
    const registry = moduleRef.get(ProcessorExplorer).explore();
    expect(
      registry.get('crewflow-scan-maintenance', 'ai-stale-turn-sweep')?.source,
    ).toBe('AiMaintenanceProcessor.aiStaleTurnSweep');
  });

  it('S1 flag OFF ⇒ nothing is read or written (a stale queued turn stays queued)', async () => {
    const org = await factory.createOrganisation('ai-stale-off');
    const ceo = await factory.createCeo(org);
    const { turnId } = await seedTurn(ceo, 'queued', 60 * MIN);
    flag = false;
    const r = await sweep.runCycle(dataSource);
    expect(r).toMatchObject({ ran: false, finalised: 0, workspaces: 0 });
    expect((await turn(turnId)).status).toBe('queued');
  });

  it('S2 a queued turn YOUNGER than the threshold (incl. a deferred successor legitimately waiting behind a running turn) is untouched', async () => {
    const org = await factory.createOrganisation('ai-stale-recent');
    const ceo = await factory.createCeo(org);
    const recent = await seedTurn(ceo, 'queued', 2 * MIN);
    // A successor deferring behind a running predecessor: its claim re-queues delayed jobs (ai-turn.<id>.w<n>) until the
    // wait cap (turn timeout + 60 s) — far below the 15-minute threshold.
    const pred = await seedTurn(ceo, 'running', 3 * MIN);
    const successor = await seedTurn(ceo, 'queued', 3 * MIN - 1000, {
      conversationId: pred.conversationId,
      seq: 3,
    });
    const r = await sweep.runCycle(dataSource);
    expect(r.ran).toBe(true);
    expect((await turn(recent.turnId)).status).toBe('queued');
    expect((await turn(successor.turnId)).status).toBe('queued');
    expect((await turn(pred.turnId)).status).toBe('running');
  });

  it('S3 a stale queued turn is finalised ONCE as failed / AI_WORKER_INTERRUPTED (stage stale_queued), never re-run; reservation refunded', async () => {
    const org = await factory.createOrganisation('ai-stale-final');
    const ceo = await factory.createCeo(org);
    const { turnId, conversationId } = await seedTurn(ceo, 'queued', 20 * MIN, {
      reserved: 4321,
    });
    const quota = moduleRef.get(AiQuotaService, { strict: false });
    const adjust = jest.spyOn(quota, 'adjustBudget');
    const r = await sweep.runCycle(dataSource);
    expect(r.finalised).toBeGreaterThanOrEqual(1);
    expect(await turn(turnId)).toMatchObject({
      status: 'failed',
      error_code: 'AI_WORKER_INTERRUPTED',
    });
    expect((await turn(turnId)).completed_at).not.toBeNull();
    expect(adjust).toHaveBeenCalledWith(
      ceo.organisationId,
      expect.any(String),
      -4321,
    );
    adjust.mockRestore();
    const a = await audits(turnId);
    expect(a.map((x) => x.action)).toEqual(['ai.turn_failed']);
    expect(a[0]!.metadata).toMatchObject({
      conversationId,
      errorCode: 'AI_WORKER_INTERRUPTED',
      stage: 'stale_queued',
    });
    // A second cycle finds nothing for it (terminal), and the model was never called (no started_at, no lease).
    const again = await sweep.runCycle(dataSource);
    expect(again.candidates).toBe(0);
    expect(
      (
        await admin.query(
          `SELECT started_at, lease_token FROM core.ai_message WHERE id = $1`,
          [turnId],
        )
      )[0],
    ).toEqual({ started_at: null, lease_token: null });
  });

  it('S4 two replicas sweeping concurrently finalise a stale turn exactly once (one audit row, one refund)', async () => {
    const org = await factory.createOrganisation('ai-stale-2rep');
    const ceo = await factory.createCeo(org);
    const { turnId, conversationId } = await seedTurn(ceo, 'queued', 30 * MIN);
    const ids = {
      turnId,
      conversationId,
      organisationId: ceo.organisationId,
      workspaceId: ceo.workspaceId!,
      userId: ceo.userId,
    };
    const results = await Promise.all([
      runner.finaliseStaleQueued(ids, 15 * MIN),
      runner.finaliseStaleQueued(ids, 15 * MIN),
      runner.finaliseStaleQueued(ids, 15 * MIN),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await audits(turnId)).toHaveLength(1);
    // And two whole cycles in parallel (the scan itself, as two replicas run it) leave the same single outcome.
    const second = await seedTurn(ceo, 'queued', 30 * MIN);
    const [c1, c2] = await Promise.all([
      sweep.runCycle(dataSource),
      sweep.runCycle(dataSource),
    ]);
    expect(await audits(second.turnId)).toHaveLength(1);
    expect(c1.finalised + c2.finalised).toBeGreaterThanOrEqual(1);
    expect((await turn(second.turnId)).status).toBe('failed');
  });

  it('S5 a queued turn claimed (running), cancelled or completed meanwhile is never touched by the compare-and-set', async () => {
    const org = await factory.createOrganisation('ai-stale-cas');
    const ceo = await factory.createCeo(org);
    const running = await seedTurn(ceo, 'running', 40 * MIN);
    const done = await seedTurn(ceo, 'completed', 40 * MIN);
    for (const t of [running, done]) {
      const ok = await runner.finaliseStaleQueued(
        {
          ...t,
          organisationId: ceo.organisationId,
          workspaceId: ceo.workspaceId!,
          userId: ceo.userId,
        },
        15 * MIN,
      );
      expect(ok).toBe(false);
    }
    expect((await turn(running.turnId)).status).toBe('running');
    expect((await turn(done.turnId)).status).toBe('completed');
  });

  it("S6 tenant isolation: the sweep binds each turn's own (org, workspace, user); another user's context sees and updates nothing; no context ⇒ zero rows", async () => {
    const orgA = await factory.createOrganisation('ai-stale-iso-a');
    const orgB = await factory.createOrganisation('ai-stale-iso-b');
    const a = await factory.createCeo(orgA);
    const b = await factory.createCeo(orgB);
    const t = await seedTurn(a, 'queued', 20 * MIN);
    // Forged ids: B's tenant binding with A's turn id ⇒ RLS hides the row ⇒ nothing finalised.
    const forged = await runner.finaliseStaleQueued(
      {
        ...t,
        organisationId: b.organisationId,
        workspaceId: b.workspaceId!,
        userId: b.userId,
      },
      15 * MIN,
    );
    expect(forged).toBe(false);
    expect((await turn(t.turnId)).status).toBe('queued');
    const tc = moduleRef.get(TenantContextService, { strict: false });
    const seenByOrgOnly = await tc.runInTenantContext(
      {
        organisationId: a.organisationId,
        workspaceId: null,
        userId: '',
        role: '',
      },
      (m) =>
        m.query(`SELECT id FROM core.ai_message WHERE id = $1`, [t.turnId]),
    );
    expect(seenByOrgOnly).toHaveLength(0);
    const unbound = await dataSource.transaction((m) =>
      m.query(`SELECT id FROM core.ai_message WHERE id = $1`, [t.turnId]),
    );
    expect(unbound).toHaveLength(0);
    // The real sweep finalises it under A's own binding.
    await sweep.runCycle(dataSource);
    expect((await turn(t.turnId)).status).toBe('failed');
    const auditOrg = await admin.query(
      `SELECT organisation_id FROM core.audit_log WHERE entity_id = $1`,
      [t.turnId],
    );
    expect(auditOrg).toEqual([{ organisation_id: a.organisationId }]);
  });

  it('S7 suspended organisation: consistent with the runner (which ends such a turn failed when its job runs) — the stale turn is finalised, nothing else is sent', async () => {
    const org = await factory.createOrganisation('ai-stale-susp');
    const ceo = await factory.createCeo(org);
    const t = await seedTurn(ceo, 'queued', 20 * MIN);
    await admin.query(
      `UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = 'd-q2 test' WHERE id = $1`,
      [org.id, ceo.userId],
    );
    try {
      await sweep.runCycle(dataSource);
      expect(await turn(t.turnId)).toMatchObject({
        status: 'failed',
        error_code: 'AI_WORKER_INTERRUPTED',
      });
      const outbox = await admin.query(
        `SELECT count(*)::int AS n FROM core.email_outbox WHERE organisation_id = $1`,
        [org.id],
      );
      expect(outbox[0].n).toBe(0);
    } finally {
      await admin.query(
        `UPDATE core.organisation SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = $1`,
        [org.id],
      );
    }
  });

  it('S8 a threshold that does not exceed the legitimate queued wait is refused (fail closed)', async () => {
    expect(runner.isSafeStaleQueuedThreshold(5 * MIN)).toBe(false);
    expect(runner.isSafeStaleQueuedThreshold(15 * MIN)).toBe(true);
    await expect(
      runner.finaliseStaleQueued(
        {
          turnId: randomUUID(),
          conversationId: randomUUID(),
          organisationId: randomUUID(),
          workspaceId: randomUUID(),
          userId: randomUUID(),
        },
        MIN,
      ),
    ).rejects.toThrow(/threshold/);
  });
  it('S9 a workspace with more eligible users than one discovery page: the LAST user by user_id is still swept (keyset pagination; CodeRabbit on #46)', async () => {
    const org = await factory.createOrganisation('ai-stale-many');
    const owner = await factory.createCeo(org);
    // The schema allows several CEO profiles in one workspace. Place PAGE_SIZE + 1 more CEOs in the owner's workspace, so
    // the workspace has PAGE_SIZE + 2 eligible users and the last one by user_id is on the second page.
    const extra: string[] = [];
    for (let i = 0; i <= AI_STALE_SWEEP_USER_PAGE_SIZE; i++) {
      const ceo = await factory.createInternalManager(org, { type: 'ceo', workspace: false, label: `ceo${i}` });
      extra.push(ceo.userId);
    }
    await admin.query(
      `UPDATE core.manager_profile SET workspace_id = $1 WHERE organisation_id = $2 AND user_id = ANY($3::uuid[])`,
      [owner.workspaceId, org.id, extra],
    );
    const last = [owner.userId, ...extra].sort().at(-1)!;
    const lastIdentity = { ...owner, userId: last };
    const { turnId } = await seedTurn(lastIdentity, 'queued', 20 * MIN);
    const r = await sweep.runCycle(dataSource);
    expect(r.ran).toBe(true);
    expect(await turn(turnId)).toMatchObject({
      status: 'failed',
      error_code: 'AI_WORKER_INTERRUPTED',
    });
    expect((await audits(turnId)).map((x) => x.action)).toEqual(['ai.turn_failed']);
  });
});
