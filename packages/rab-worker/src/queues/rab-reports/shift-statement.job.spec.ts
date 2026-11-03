import { fakeTenant, PRE_PHASE_D_SQL_SHA256, sha256 } from '../../__tests__/helpers/dispatch-fakes';
import { ReportScanProcessor } from './report.processors';
import { dispatchStatementScope, runShiftStatementDispatchCycle, shiftStatementJobOptions } from './shift-statement.job';

/** Phase D (D1): statement dispatcher — per_scope byte-for-byte; global = same scan + per-row CAS restricted to the claimed ids. */
const ORG = '00000000-0000-4000-8000-00000000000a';
const WS = '00000000-0000-4000-8000-0000000000a1';
const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';

function responder(candidates: unknown[], generation: number | null = 4) {
  let pageServed = false;
  return (sql: string) => {
    if (sql.includes('worker_list_workspaces')) {
      if (pageServed) return [];
      pageServed = true;
      return [{ workspace_id: WS, organisation_id: ORG }];
    }
    if (sql.startsWith('SELECT id, organisation_id, workspace_id, statement_status FROM payroll_record')) return candidates;
    if (sql.startsWith('UPDATE payroll_record SET statement_status = \'queued\'')) return [generation === null ? [] : [{ generation }], generation === null ? 0 : 1];
    return [];
  };
}

describe('shift statement dispatch', () => {
  it('per_scope: the discovery scan and the per-row CAS are byte-for-byte the pre-Phase-D SQL', async () => {
    const { tenant, dataSource, statements } = fakeTenant(responder([{ id: P1, organisation_id: ORG, workspace_id: WS, statement_status: 'pending' }]));
    const publish = jest.fn(async () => undefined);
    const result = await runShiftStatementDispatchCycle(dataSource as never, tenant as never, publish);
    const scan = statements.find((s) => s.sql.startsWith('SELECT id, organisation_id, workspace_id, statement_status'))!;
    const cas = statements.find((s) => s.sql.startsWith("UPDATE payroll_record SET statement_status = 'queued'"))!;
    expect(sha256(scan.sql)).toBe(PRE_PHASE_D_SQL_SHA256.statementScan);
    expect(sha256(cas.sql)).toBe(PRE_PHASE_D_SQL_SHA256.statementCas);
    expect(publish).toHaveBeenCalledWith({ payrollRecordId: P1, organisationId: ORG, workspaceId: WS, generation: 4 });
    expect(result).toMatchObject({ claimed: 1, published: 1 });
  });

  it('global: scans only the claimed ids in a READ ONLY worker-context transaction of the pointer\'s workspace, then the SAME CAS per row', async () => {
    const { tenant, statements, contexts } = fakeTenant(responder([{ id: P1, organisation_id: ORG, workspace_id: WS, statement_status: 'none' }]));
    const publish = jest.fn(async () => undefined);
    const result = await dispatchStatementScope(tenant as never, ORG, WS, [P1, P2], publish);
    expect(contexts.every((c) => c.organisationId === ORG && c.workspaceId === WS && c.actorType === 'worker')).toBe(true);
    const scan = statements.find((s) => s.sql.startsWith('SELECT id, organisation_id, workspace_id, statement_status'))!;
    expect(statements[statements.indexOf(scan) - 1]!.sql).toBe('SET TRANSACTION READ ONLY');
    expect(scan.sql).toContain('AND id = ANY($1::uuid[])');
    expect(scan.params).toEqual([[P1, P2]]);
    const cas = statements.find((s) => s.sql.startsWith("UPDATE payroll_record SET statement_status = 'queued'"))!;
    expect(sha256(cas.sql)).toBe(PRE_PHASE_D_SQL_SHA256.statementCas);
    expect(cas.tx).not.toBe(scan.tx); // the claim is its own short transaction, committed before publishing
    expect(publish).toHaveBeenCalledWith({ payrollRecordId: P1, organisationId: ORG, workspaceId: WS, generation: 4 });
    expect(result).toMatchObject({ claimed: 1, published: 1, reconciledMissing: 1 });
  });

  it('global: a row another dispatcher already claimed (CAS affects nothing) is not published', async () => {
    const { tenant } = fakeTenant(responder([{ id: P1, organisation_id: ORG, workspace_id: WS, statement_status: 'pending' }], null));
    const publish = jest.fn(async () => undefined);
    const result = await dispatchStatementScope(tenant as never, ORG, WS, [P1], publish);
    expect(publish).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
  });

  it('the global-mode publisher builds exactly the BullMQ add() the report processor builds (same jobId, attempts, retention)', async () => {
    const add = jest.fn(async () => undefined);
    const deps = {
      get: () => ({
        runtimeDataSource: fakeTenant(responder([{ id: P1, organisation_id: ORG, workspace_id: WS, statement_status: 'pending' }])).dataSource,
        tenantContext: fakeTenant(responder([{ id: P1, organisation_id: ORG, workspace_id: WS, statement_status: 'pending' }])).tenant,
        shiftStatementQueue: { name: 'rab-shift-statements', add }, // D-Q1: the registry name is checked before add
        logger: { log: jest.fn() },
      }),
    };
    await new ReportScanProcessor(deps as never).shiftStatementDispatch();
    const data = { payrollRecordId: P1, organisationId: ORG, workspaceId: WS, generation: 4 };
    expect(add).toHaveBeenCalledWith(...shiftStatementJobOptions(data));
  });

  it('global: a publish that fails fast (Redis unavailable) is counted, never thrown — the claim stays for its lease, the runner moves on', async () => {
    const { tenant } = fakeTenant(responder([{ id: P1, organisation_id: ORG, workspace_id: WS, statement_status: 'pending' }, { id: P2, organisation_id: ORG, workspace_id: WS, statement_status: 'pending' }]));
    const publish = jest.fn(async () => {
      throw Object.assign(new Error('Redis is unavailable'), { name: 'QueuePublishUnavailableError' });
    });
    await expect(dispatchStatementScope(tenant as never, ORG, WS, [P1, P2], publish)).resolves.toMatchObject({ claimed: 2, published: 0, publishFailed: 2 });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
