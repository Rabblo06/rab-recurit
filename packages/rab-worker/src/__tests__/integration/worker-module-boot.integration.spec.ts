import './helpers/email-reliability-env'; // FIRST: env is frozen when a module reading it is imported
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';

import { FieldPolicyService } from '@rab/server/modules/identity/member-access/field-policy.service';
import { PayrollService } from '@rab/server/modules/payroll/services/payroll.service';
import { ShiftReportService } from '@rab/server/modules/attendance/services/shift-report.service';
import { WorkerModule } from '../../worker.module';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

/**
 * Waves 4+5 integration regression: the jobs child builds its OWN Nest graph (WorkerModule), not the API's AppModule.
 * Wave 5 made PayrollService / ShiftReportService / AttendanceService inject FieldPolicyService, which only the API's
 * global MemberAccessModule provided — every worker suite boots AppModule, so none of them noticed, and the rebuilt
 * dev worker refused to start (UnknownDependenciesException on PayrollService.fieldPolicy). This compiles the real
 * WorkerModule, exactly as rab-worker/src/main.ts does, so a provider the worker graph cannot resolve fails here.
 */
describeIfDb('WorkerModule boots on its own (integration)', () => {
  jest.setTimeout(120_000);
  let moduleRef: TestingModule | undefined;

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('compiles and initialises the real WorkerModule; the wave-5 field policy reaches the payroll and report services', async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(FieldPolicyService, { strict: false })).toBeInstanceOf(FieldPolicyService);
    const payroll = moduleRef.get(PayrollService, { strict: false }) as unknown as { fieldPolicy?: unknown };
    expect(payroll.fieldPolicy).toBeInstanceOf(FieldPolicyService);
    expect(moduleRef.get(ShiftReportService, { strict: false })).toBeInstanceOf(ShiftReportService);
  });
});
