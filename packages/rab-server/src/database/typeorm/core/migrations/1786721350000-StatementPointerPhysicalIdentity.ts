import { MigrationInterface, QueryRunner } from 'typeorm';

import { secureOwnerInvariantViolations } from '../secure-owner-invariants';
import {
  BOOTSTRAP_IDENTITY_SQL,
  BootstrapIdentityFacts,
  bootstrapIdentityProblems,
  F2_FUNCTIONS,
  F2_ROLE_ASSERT_SQL,
  F2_TABLE_DOWN_SQL,
  F2_TABLE_EXPECTED_DOWN,
  F2_TABLE_EXPECTED_UP,
  F2_TABLE_STATE_SQL,
  F2_TABLE_UP_SQL,
  functionBody,
  LOCK_TIMEOUT_SQL,
  orReplace,
  OUTBOX_FUNCTIONS_EXPECTED,
  OUTBOX_FUNCTIONS_STATE_SQL,
  STATEMENT_FUNCTION_EXPECTED,
  STATEMENT_FUNCTION_STATE_SQL,
  WORKER_DISPATCH_POINTER_EXPECTED_STATE,
  WORKER_DISPATCH_POINTER_STATE_SQL,
} from '../worker-dispatch-pointer-sql';

/**
 * Phase D, finding F2 (owner-approved 2026-11-01, option C): the dispatch-pointer identity becomes the physical source row,
 * `(queue, subject_id, source_schema)`, where source_schema is 'core' or the row's own 'workspace_<hex>'. A payroll_record
 * can exist twice with one id and one workspace (the HWS backfill keeps ids), so under the old `(queue, subject_id)` key a
 * write to one copy (terminal update, delete, backfill rollback, TRUNCATE core) removed the pointer the other copy still
 * needed. Now every trigger write or delete is scoped to its own copy; a generated statement retires the same record's
 * other copies' pointers in the SAME workspace (generation is fenced per id: core.worker_event 'shift-statement:<id>' is
 * UNIQUE); the claim gives every row its own token. Exact SQL: the F2_* builders in ../worker-dispatch-pointer-sql.ts —
 * the approved constants of 1786721300000 / 1310000 / 1320000 are untouched.
 *
 * Core only: no workspace DDL, so the v19 workspace fingerprint is unchanged (the fingerprint covers trigger definitions,
 * not the core function body). No GRANT / REVOKE: CREATE OR REPLACE keeps owner, SECURITY DEFINER, search_path and ACLs
 * (post-conditions below). Must ship in the same release as 1786721300000–1340000, before any global-mode activation:
 * existing statement pointers are removed (their source is unknown); per_scope never reads them, and in global mode the
 * per-workspace legacy sweep finds the work until each record's next write re-creates its pointer.
 *
 * Authority: the CF-41 / Phase 0b bootstrap identity (superuser, or a login that can SET ROLE rab_secure_owner, the owner of
 * the table and of every replaced function). E-8: lock_timeout 5 s (ACCESS EXCLUSIVE on the pointer table only).
 *
 * down(): restores the approved bodies and the `(queue, subject_id)` key exactly, after removing statement pointers (two
 * copies may each hold one). Must run before 1786721320000.down(), which makes the statement function inert.
 */
export class StatementPointerPhysicalIdentity1786721350000 implements MigrationInterface {
  name = 'StatementPointerPhysicalIdentity1786721350000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    await queryRunner.query(LOCK_TIMEOUT_SQL);
    await queryRunner.query('SET LOCAL ROLE rab_secure_owner');
    await queryRunner.query(F2_ROLE_ASSERT_SQL);
    for (const sql of F2_TABLE_UP_SQL) await queryRunner.query(sql);
    for (const f of F2_FUNCTIONS) await queryRunner.query(f.up);
    await queryRunner.query('RESET ROLE');
    await this.verify(queryRunner, 'up');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner);
    await this.preflight(queryRunner);
    await queryRunner.query(LOCK_TIMEOUT_SQL);
    await queryRunner.query('SET LOCAL ROLE rab_secure_owner');
    await queryRunner.query(F2_ROLE_ASSERT_SQL);
    for (const f of F2_FUNCTIONS) await queryRunner.query(orReplace(f.down));
    for (const sql of F2_TABLE_DOWN_SQL) await queryRunner.query(sql);
    await queryRunner.query('RESET ROLE');
    await this.verify(queryRunner, 'down');
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const [f] = (await queryRunner.query(BOOTSTRAP_IDENTITY_SQL)) as BootstrapIdentityFacts[];
    const problems = bootstrapIdentityProblems(f);
    if (f && !f.su && !f.can_set_secure) problems.push('cannot SET ROLE rab_secure_owner (owner of the pointer table and of every replaced function)');
    const [t] = (await queryRunner.query(`SELECT pg_catalog.to_regclass('core.worker_dispatch_pointer') IS NOT NULL AS present`)) as Array<{ present: boolean }>;
    if (!t?.present) problems.push('core.worker_dispatch_pointer does not exist (WorkerDispatchPointer1786721300000 first)');
    if (problems.length) throw new Error(`${this.name}: refusing to run as ${f?.who ?? 'unknown'}: ${problems.join('; ')}.`);
  }

  /** Post-conditions (rolled back on any mismatch): key + check, exact bodies, unchanged owner / definer / config / ACLs, R4. */
  private async verify(queryRunner: QueryRunner, phase: 'up' | 'down'): Promise<void> {
    const problems: string[] = [];
    const [table] = (await queryRunner.query(F2_TABLE_STATE_SQL)) as Array<Record<string, unknown>>;
    const expected = phase === 'up' ? F2_TABLE_EXPECTED_UP : F2_TABLE_EXPECTED_DOWN;
    if (JSON.stringify(table) !== JSON.stringify(expected)) problems.push(`table ${JSON.stringify(table)} ≠ ${JSON.stringify(expected)}`);
    for (const f of F2_FUNCTIONS) {
      const [p] = (await queryRunner.query(`SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = '${f.signature}'::pg_catalog.regprocedure`)) as Array<{ prosrc: string }>;
      if (p?.prosrc !== functionBody(phase === 'up' ? f.up : f.down)) problems.push(`${f.signature}: body is not the reviewed ${phase} body`);
    }
    const [pointer] = (await queryRunner.query(WORKER_DISPATCH_POINTER_STATE_SQL)) as Array<Record<string, unknown>>;
    if (JSON.stringify(pointer) !== JSON.stringify(WORKER_DISPATCH_POINTER_EXPECTED_STATE)) problems.push(`pointer table / claim functions: ${JSON.stringify(pointer)}`);
    const [outbox] = (await queryRunner.query(OUTBOX_FUNCTIONS_STATE_SQL)) as Array<{ functions: string | null }>;
    if (outbox?.functions !== OUTBOX_FUNCTIONS_EXPECTED) problems.push(`outbox trigger functions: ${outbox?.functions ?? 'none'}`);
    const [statement] = (await queryRunner.query(STATEMENT_FUNCTION_STATE_SQL)) as Array<Record<string, unknown>>;
    if (JSON.stringify(statement) !== JSON.stringify(STATEMENT_FUNCTION_EXPECTED)) problems.push(`statement trigger function: ${JSON.stringify(statement)}`);
    problems.push(...(await secureOwnerInvariantViolations((sql) => queryRunner.query(sql))));
    if (problems.length) throw new Error(`${this.name}: post-condition failed after ${phase}() (rolled back):\n  ${problems.join('\n  ')}`);
  }
}

/** Same as Phase 0b: this session resolves names in pg_catalog only; every object named here is core-qualified. */
async function pinSearchPath(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}
