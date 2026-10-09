import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { schedulePointer } from '@rab/server/engine/core-modules/due-work/schedule-due-work';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { claimDueWork, completeDueWork, rescheduleDueWork } from '../../core/database/due-work';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Due-work pointer foundation (HWS Phase 3). The pointer is discovery only. These tests prove the properties the timer jobs depend on:
 * only due pointers are selected, batches are bounded, two claimers never share a pointer, an expired lease is claimable again, a stale
 * lease holder cannot finish someone else's claim, and a workspace cannot write a pointer into another workspace.
 *
 * Every pointer here is written under a real tenant context. Claims run on the runtime DataSource (rab_app), as production does.
 */
const JOB = 'manager_confirmation_timeout' as const;

describe('due-work pointer foundation (integration)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let manager: TestIdentity;
  let otherOrg: Organisation;
  let otherManager: TestIdentity;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    runtime = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: runtime,
      adminDataSource,
      tenantContext,
      passwordHashing: app.get(PasswordHashingService),
    });
    org = await factory.createOrganisation('due-work-a');
    manager = await factory.createInternalManager(org, { permissions: 'production', label: 'due-a' });
    otherOrg = await factory.createOrganisation('due-work-b');
    otherManager = await factory.createInternalManager(otherOrg, { permissions: 'production', label: 'due-b' });
  }, 120_000);

  afterAll(async () => {
    await adminDataSource?.destroy();
    await app?.close();
  });

  const ctxA = () => ({ organisationId: org.id, workspaceId: manager.workspaceId!, userId: manager.userId, role: '' });

  async function schedule(dueOffsetMs: number, subject = randomUUID()): Promise<string> {
    await tenantContext.runInTenantContext(ctxA(), (m) =>
      schedulePointer(m, {
        organisationId: org.id,
        workspaceId: manager.workspaceId!,
        jobType: JOB,
        subjectType: 'job_offer',
        subjectId: subject,
        dueAt: new Date(Date.now() + dueOffsetMs),
      }),
    );
    return subject;
  }
  async function pointerIdFor(subject: string): Promise<string> {
    const [row] = await adminDataSource.query<Array<{ id: string }>>(`SELECT id FROM core.worker_due_work WHERE subject_id = $1`, [subject]);
    return row!.id;
  }

  it('selects only pointers that are due: a future pointer is not returned', async () => {
    const due = await schedule(-60_000);
    const future = await schedule(3_600_000);
    const claimed = await claimDueWork(runtime, JOB, { batch: 500, leaseSeconds: 120 });
    const subjects = claimed.map((c) => c.subject_id);
    expect(subjects).toContain(due);
    expect(subjects).not.toContain(future);
    // Put the claimed pointer back so later tests in this file see a clean state.
    for (const c of claimed.filter((c) => c.subject_id === due)) await rescheduleDueWork(runtime, c.pointer_id, c.lease_token, new Date(Date.now() + 3_600_000));
  });

  it('is bounded: a claim returns at most the requested batch, however many pointers are due', async () => {
    for (let i = 0; i < 5; i++) await schedule(-60_000);
    const claimed = await claimDueWork(runtime, JOB, { batch: 2, leaseSeconds: 120 });
    expect(claimed.length).toBeLessThanOrEqual(2);
    for (const c of claimed) await rescheduleDueWork(runtime, c.pointer_id, c.lease_token, new Date(Date.now() + 3_600_000));
  });

  it('two concurrent claimers never receive the same pointer', async () => {
    const subjects = [await schedule(-60_000), await schedule(-60_000), await schedule(-60_000)];
    const [a, b] = await Promise.all([
      claimDueWork(runtime, JOB, { batch: 50, leaseSeconds: 120 }),
      claimDueWork(runtime, JOB, { batch: 50, leaseSeconds: 120 }),
    ]);
    const idsA = new Set(a.map((c) => c.pointer_id));
    for (const c of b) expect(idsA.has(c.pointer_id)).toBe(false);
    const mine = [...a, ...b].filter((c) => subjects.includes(c.subject_id));
    expect(mine.length).toBe(3);
    for (const c of mine) await completeDueWork(runtime, c.pointer_id, c.lease_token);
  });

  it('a crashed claim is reclaimable after its lease expires, with a new lease token and a higher attempt count', async () => {
    const subject = await schedule(-60_000);
    const [first] = (await claimDueWork(runtime, JOB, { batch: 500, leaseSeconds: 5 })).filter((c) => c.subject_id === subject);
    expect(first).toBeDefined();
    // Simulated crash: the claimant never completes. Wait for the 5 s lease to lapse.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const [second] = (await claimDueWork(runtime, JOB, { batch: 500, leaseSeconds: 120 })).filter((c) => c.subject_id === subject);
    expect(second).toBeDefined();
    expect(second!.pointer_id).toBe(first!.pointer_id);
    expect(second!.lease_token).not.toBe(first!.lease_token);
    expect(second!.attempt_count).toBe(first!.attempt_count + 1);
    await completeDueWork(runtime, second!.pointer_id, second!.lease_token);
  }, 30_000);

  it('a stale lease holder cannot complete or reschedule a pointer after its lease was reclaimed', async () => {
    const subject = await schedule(-60_000);
    const [stale] = (await claimDueWork(runtime, JOB, { batch: 500, leaseSeconds: 5 })).filter((c) => c.subject_id === subject);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const [fresh] = (await claimDueWork(runtime, JOB, { batch: 500, leaseSeconds: 120 })).filter((c) => c.subject_id === subject);
    expect(await completeDueWork(runtime, stale!.pointer_id, stale!.lease_token)).toBe(false);
    expect(await rescheduleDueWork(runtime, stale!.pointer_id, stale!.lease_token, new Date(Date.now() + 3_600_000))).toBe(false);
    // The fresh holder still owns it and can complete it.
    expect(await completeDueWork(runtime, fresh!.pointer_id, fresh!.lease_token)).toBe(true);
    const left = await adminDataSource.query(`SELECT id FROM core.worker_due_work WHERE subject_id = $1`, [subject]);
    expect(left).toHaveLength(0);
  }, 30_000);

  it('a rescheduled pointer is not due until its new time', async () => {
    const subject = await schedule(-60_000);
    const [claim] = (await claimDueWork(runtime, JOB, { batch: 500, leaseSeconds: 120 })).filter((c) => c.subject_id === subject);
    expect(await rescheduleDueWork(runtime, claim!.pointer_id, claim!.lease_token, new Date(Date.now() + 3_600_000))).toBe(true);
    const again = (await claimDueWork(runtime, JOB, { batch: 500, leaseSeconds: 120 })).filter((c) => c.subject_id === subject);
    expect(again).toHaveLength(0);
    await adminDataSource.query(`DELETE FROM core.worker_due_work WHERE subject_id = $1`, [subject]);
  });

  it('a workspace cannot write a pointer into another workspace (RLS WITH CHECK refuses it)', async () => {
    await expect(
      tenantContext.runInTenantContext(ctxA(), (m) =>
        schedulePointer(m, {
          organisationId: otherOrg.id,
          workspaceId: otherManager.workspaceId!,
          jobType: JOB,
          subjectType: 'job_offer',
          subjectId: randomUUID(),
          dueAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('a workspace cannot move an existing pointer to another workspace (the UPDATE is refused or matches nothing)', async () => {
    const subject = await schedule(-60_000);
    const id = await pointerIdFor(subject);
    const moved = await tenantContext
      .runInTenantContext(ctxA(), (m) =>
        m.query(`UPDATE core.worker_due_work SET workspace_id = $1 WHERE id = $2 RETURNING id`, [otherManager.workspaceId, id]),
      )
      .then((r: unknown) => r)
      .catch(() => 'refused');
    const stillA = await adminDataSource.query(`SELECT workspace_id FROM core.worker_due_work WHERE id = $1`, [id]);
    expect(stillA[0].workspace_id).toBe(manager.workspaceId);
    expect(moved === 'refused' || (Array.isArray(moved) && (moved[0] as unknown[]).length === 0)).toBe(true);
    await adminDataSource.query(`DELETE FROM core.worker_due_work WHERE id = $1`, [id]);
  });

  it('the schema scope is the pointer row, not a request parameter: the claim takes no workspace or schema input', async () => {
    const signature = await adminDataSource.query<Array<{ args: string }>>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p WHERE p.proname = 'worker_claim_due_work'`,
    );
    expect(signature[0]!.args).toBe('p_job_type text, p_batch integer, p_lease_seconds integer');
  });
});
