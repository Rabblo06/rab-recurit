import './helpers/local-storage-env'; // FIRST: env is frozen when the Nest config module is imported
import { WORKER_LOGIN_ACTIVE } from './helpers/worker-login-env'; // then: the runtime login becomes crewflow_worker (global)
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runStorageCleanupCycle } from '../../queues/rab-maintenance/storage-cleanup.job';
import { WorkerModule } from '../../worker.module';
import { assertRoleGate, BootGateFacts } from '@rab/server/database/boot-checks/database-boot-gate-rules';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * Phase D (independent security review F1): the Worker's scheduled storage cleanup on the Worker-only login. Global claim
 * mode requires the Worker to log in as crewflow_worker; the embedded `storage:reconcile` command asserted its connections
 * as the API identity (crewflow_app only), so every storage-cleanup tick refused to run and storage retention stopped
 * silently. The Worker now asserts them as the Worker identity; the CLI keeps refusing the Worker's credential.
 * Opt-in like the other Phase D Worker specs: PHASE_D_SQL_APPROVED=true and TEST_DATABASE_WORKER_URL.
 */
const describeIfWorkerLogin = WORKER_LOGIN_ACTIVE && integrationTestDatabaseReady() ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfWorkerLogin('Phase D: storage cleanup on the crewflow_worker login, global claim mode (integration)', () => {
  let moduleRef: TestingModule;
  let command: StorageReconcileCommand;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();
    const [{ current_user: role }] = await moduleRef.get(DataSource).query('SELECT current_user');
    // BC-08 (Phase D under one login): the Worker runs on crewflow_owner; crewflow_worker is a schema role.
    expect(role).toBe('crewflow_owner');
    expect(process.env.WORKER_CLAIM_MODE).toBe('global');
    command = moduleRef.get(StorageReconcileCommand, { strict: false });
    moduleRef.get(WorkerDependencies).provide({
      logger: new Logger('phase-d-storage-cleanup-it'),
      environmentService: moduleRef.get(EnvironmentService),
      storageReconcileCommand: command,
    } as never);
  });

  afterEach(() => {
    process.exitCode = undefined; // a CLI-style run reports through the exit code; never leak it into Jest
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it("the Worker's scheduled cycle reconciles (lock and runtime connections both as crewflow_worker)", async () => {
    const result = await runStorageCleanupCycle(command, 30);
    expect(result).toMatchObject({ ran: true });
    expect(command.lastReport).toBeDefined();
  });

  // Owner-login architecture. Under the one login the operator CLI runs as crewflow_owner by design (Agent 3's CLI gate
  // expects the owner): a CLI-style run on the Worker's credential is no longer refused. OWNER-LOGIN DIFFERENCE BC-02 / BC-08
  // (BC-02 one login for every process, behaviour change; BC-08 DBA-01 lost, ACCEPTED (owner, 2026-11-05)), reproduced green. The SCHEMA ROLE crewflow_worker keeps the
  // refusal below (a connection acting as it is refused by the command).
  it('BC-02 / BC-08: a CLI-style run on the one runtime credential runs (the operator command and the Worker share crewflow_owner)', async () => {
    await command.run([], { lockWaitSeconds: 0 }); // resolves (measured on #72)
    expect(command.lastReport).toBeDefined();
    // The schema role crewflow_worker is still refused by the CLI role gate (it can never be the operator identity).
    expect(() =>
      assertRoleGate({ who: 'crewflow_worker', login: 'crewflow_worker' } as unknown as BootGateFacts, ['crewflow_owner'], 'CLI command "storage:reconcile"'),
    ).toThrow(/connects as "crewflow_worker", a schema role/);
  });
});
