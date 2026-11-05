process.env.PUSH_ENABLED = 'true';

import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import {
  DispatchClaim,
  RELEASE_RETRY_AFTER_ERROR_SECONDS,
  runGlobalDispatch,
} from '../../core/database/dispatch-claims';
import {
  dispatchPushScope,
  runPushDispatchCycle,
} from '../../queues/rab-push/push-dispatch.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * D-Q3 independent review R1. In WORKER_CLAIM_MODE=global a push publish error must keep its pre-D-Q3 outcome: the
 * error propagates out of the scope, runGlobalDispatch releases the remaining claims with RELEASE_RETRY_AFTER_ERROR_SECONDS
 * (15 s) and ends the run. The per_scope-only `queued_at` withdrawal must NOT happen there: it would fire the pointer trigger
 * (due now, claim cleared) and the same run would re-claim the pointer every batch.
 *
 * OPT-IN like the other Phase D suites: needs the Phase D migrations and the `crewflow_worker` login
 * (PHASE_D_SQL_APPROVED=true + TEST_DATABASE_WORKER_URL).
 */
jest.setTimeout(120_000);
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN =
  process.env.PHASE_D_SQL_APPROVED === 'true' &&
  Boolean(WORKER_URL && process.env.DATABASE_URL);
const describeIfApproved = RUN ? describe : describe.skip;

describeIfApproved(
  'push dispatch: a publish failure in global claim mode (integration — opt-in)',
  () => {
    let app: INestApplication;
    let runtime: DataSource;
    let admin: DataSource;
    let worker: DataSource;
    let tenantContext: TenantContextService;
    let owner: TestIdentity;
    const logger = { log: () => undefined, warn: () => undefined };

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      runtime = app.get(DataSource);
      tenantContext = app.get(TenantContextService);
      admin = createAdminDataSource();
      await admin.initialize();
      worker = new DataSource({
        type: 'postgres',
        url: WORKER_URL,
        entities: [],
        synchronize: false,
        extra: { max: 2, application_name: 'crewflow-worker-it' },
      });
      await worker.initialize();
      const [{ current_user: who }] = await worker.query<
        [{ current_user: string }]
      >('SELECT current_user');
      // BC-08 (Phase D under one login): the Worker runs on crewflow_owner; crewflow_worker is a schema role.
      expect(who).toBe('crewflow_owner');
      const factory = new TestIdentityFactory({
        app,
        dataSource: runtime,
        adminDataSource: admin,
        tenantContext,
        passwordHashing: app.get(PasswordHashingService),
      });
      const org = await factory.createOrganisation('push-global-fail');
      owner = await factory.createInternalManager(org, { label: 'pushgf' });
    });

    afterAll(async () => {
      await worker?.destroy();
      await admin?.destroy();
      await app?.close();
    });

    /** A PENDING push row; its INSERT fires the pointer trigger (pointer due now). */
    async function seedPush(): Promise<string> {
      const notificationId = randomUUID();
      const deviceId = randomUUID();
      await admin.query(
        `INSERT INTO core.notification (id, organisation_id, user_id, type, title, message) VALUES ($1, $2, $3, 'TEST', 't', 'm')`,
        [notificationId, owner.organisationId, owner.userId],
      );
      const envelope = Buffer.concat([
        Buffer.from('RAB2'),
        Buffer.from([1]),
        Buffer.from('x'),
        Buffer.alloc(40, 7),
      ]);
      await admin.query(
        `INSERT INTO core.push_device (id, organisation_id, user_id, device_id, platform, push_token_encrypted) VALUES ($1, $2, $3, $4, 'ios', $5)`,
        [
          deviceId,
          owner.organisationId,
          owner.userId,
          `gf-${deviceId}`,
          envelope,
        ],
      );
      const id = randomUUID();
      await admin.query(
        `INSERT INTO core.push_delivery (id, organisation_id, notification_id, push_device_id, status) VALUES ($1, $2, $3, $4, 'PENDING')`,
        [id, owner.organisationId, notificationId, deviceId],
      );
      return id;
    }
    const pointerOf = async (id: string) =>
      (
        await admin.query<Array<{ claim_count: number; due_in_s: number }>>(
          `SELECT claim_count, extract(epoch FROM (due_at - now()))::float AS due_in_s FROM core.worker_dispatch_pointer WHERE queue = 'push' AND subject_id = $1`,
          [id],
        )
      )[0];
    const queuedAtOf = async (id: string) =>
      (
        await admin.query<Array<{ queued_at: Date | null }>>(
          `SELECT queued_at FROM core.push_delivery WHERE id = $1`,
          [id],
        )
      )[0]!.queued_at;

    it('the failing row is claimed ONCE in the run (no hot re-claim), released (not due again before the 15 s retry), and its queued_at is not withdrawn', async () => {
      const id = await seedPush();
      expect(await pointerOf(id)).toMatchObject({ claim_count: 0 });
      // Isolation in a shared test database: every OTHER push pointer is pushed an hour out, so this run claims only ours.
      await admin.query(
        `UPDATE core.worker_dispatch_pointer SET due_at = now() + interval '1 hour' WHERE queue = 'push' AND subject_id <> $1`,
        [id],
      );
      const claimsOfRow: DispatchClaim[] = [];
      let publishCalls = 0;
      const failing = async (): Promise<void> => {
        publishCalls += 1;
        throw Object.assign(new Error('Redis is unavailable'), {
          name: 'QueuePublishUnavailableError',
        });
      };
      await expect(
        runGlobalDispatch({
          claimer: worker,
          queue: 'push',
          batch: 100,
          maxBatches: 10,
          logger,
          onClaimed: (claims) =>
            claimsOfRow.push(...claims.filter((c) => c.subjectId === id)),
          processScope: (scope) =>
            dispatchPushScope(
              tenantContext,
              scope.organisationId,
              scope.subjectIds,
              failing,
              failing,
              false,
            ),
        }),
      ).rejects.toThrow('Redis is unavailable');
      expect(claimsOfRow).toHaveLength(1);
      expect(publishCalls).toBe(1);
      const pointer = await pointerOf(id);
      expect(pointer!.claim_count).toBe(1);
      // Not left due now: never sooner than the after-error release (15 s). The pointer actually comes due at queued_at +
      // 2 min — the claim transaction's own first-publish stamp fires the pointer trigger (re-timed, claim cleared), so the
      // 15 s release is token-refused. That is exactly the pre-D-Q3 global behaviour (the stamp happened there too).
      expect(pointer!.due_in_s).toBeGreaterThan(
        RELEASE_RETRY_AFTER_ERROR_SECONDS - 5,
      );
      expect(pointer!.due_in_s).toBeLessThanOrEqual(121);
      expect(await queuedAtOf(id)).not.toBeNull(); // the claim's stamp stays, as before D-Q3

      // An immediate second run claims nothing for it (it is not due again until the retry).
      const again: DispatchClaim[] = [];
      await runGlobalDispatch({
        claimer: worker,
        queue: 'push',
        batch: 100,
        maxBatches: 10,
        logger,
        onClaimed: (claims) =>
          again.push(...claims.filter((c) => c.subjectId === id)),
        processScope: async () => undefined,
      });
      expect(again).toHaveLength(0);
    });

    it('per_scope (contrast, unchanged): the same failure is caught per row and the stamp is withdrawn so the next tick retries it', async () => {
      const id = await seedPush();
      const result = await runPushDispatchCycle(
        runtime,
        tenantContext,
        async (pid) => {
          if (pid === id) throw new Error('Redis is unavailable');
        },
        async () => undefined,
        false,
      );
      expect(result.publishFailed).toBeGreaterThanOrEqual(1);
      expect(await queuedAtOf(id)).toBeNull();
    });
  },
);
