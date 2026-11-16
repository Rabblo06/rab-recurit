import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { DataSource, EntityManager } from 'typeorm';

import { AuditService } from '../engine/core-modules/audit/audit.service';
import { EnvironmentService } from '../engine/core-modules/environment/environment.service';
import { FileKind } from '../engine/core-modules/storage/file-kinds';
import { FileService } from '../engine/core-modules/storage/file.service';
import { StorageDriverFactory } from '../engine/core-modules/storage/storage-driver.factory';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { assertOneRow, StorageMigrateLocalCommand } from './storage-migrate-local.command';

/**
 * O-2 review (MEDIUM): under --apply every link / clear UPDATE must change exactly the one row it names. An UPDATE that
 * RLS (or a concurrent change) makes match 0 rows must roll back the stored_file registration and the audit entry with it
 * and report `failed` — never `migrated` with a false FILE_MIGRATION_COMPLETED row. manager_workspace logos are
 * `unsupported` and never touched.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01]);

type Legacy = { table: 'user' | 'organisation' | 'manager_workspace'; rowId: string; organisationId: string; workspaceId: string | null; key: string; kind: string; resourceType: string };

function setup(updateCounts: { link: number; clear: number }) {
  const transactions: Array<'commit' | 'rollback'> = [];
  const statements: string[] = [];
  const manager = {
    query: jest.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SET avatar_file_id') || sql.includes('SET logo_file_id')) return [new Array(updateCounts.link).fill({ id: USER }), updateCounts.link];
      if (sql.includes('SET avatar_key = NULL') || sql.includes('SET logo_key = NULL')) return [new Array(updateCounts.clear).fill({ id: USER }), updateCounts.clear];
      return [];
    }),
  } as unknown as EntityManager;
  const tenantContext = {
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (m: EntityManager) => Promise<unknown>) => {
      try {
        const result = await fn(manager);
        transactions.push('commit');
        return result;
      } catch (error) {
        transactions.push('rollback');
        throw error;
      }
    }),
  } as unknown as TenantContextService;
  const files = {
    validateContent: jest.fn(() => ({ ext: 'png', mimeType: 'image/png' })),
    putObject: jest.fn(async () => ({ objectKey: 'k' })),
    registerAvailable: jest.fn(async () => ({ id: 'file-1', sizeBytes: PNG.length })),
    findAvailable: jest.fn(async () => ({ id: 'file-1' })),
    readVerified: jest.fn(async () => PNG),
  } as unknown as FileService;
  const drivers = { getDriver: () => ({ name: 'S3' }) } as unknown as StorageDriverFactory;
  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;
  const env = { get: jest.fn(() => '') } as unknown as EnvironmentService;
  const command = new StorageMigrateLocalCommand({} as DataSource, tenantContext, files, drivers, audit, env);
  return { command, transactions, statements, files, audit };
}

describe('storage:migrate-local --apply row-count checks (O-2 review)', () => {
  let root: string;
  let logs: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'o2-apply-'));
    logs = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    process.exitCode = 0;
  });

  function userItem(): Legacy {
    const key = `org/${ORG}/avatars/a.png`;
    mkdirSync(dirname(join(root, key)), { recursive: true });
    writeFileSync(join(root, key), PNG);
    return { table: 'user', rowId: USER, organisationId: ORG, workspaceId: null, key, kind: FileKind.PROFILE_IMAGE, resourceType: 'user' };
  }

  async function run(command: StorageMigrateLocalCommand, items: Legacy[]) {
    jest.spyOn(command as unknown as { discover: () => Promise<Legacy[]> }, 'discover').mockResolvedValue(items);
    await command.run([], { source: root, apply: true });
    return JSON.parse(logs[logs.length - 1]!) as { results: Array<{ table: string; rowId: string; outcome: string; detail?: string }> };
  }

  it('a link UPDATE that matches 0 rows: outcome failed, the registration transaction rolls back, no audit entry', async () => {
    const t = setup({ link: 0, clear: 1 });
    const report = await run(t.command, [userItem()]);
    expect(report.results).toEqual([{ table: 'user', rowId: USER, outcome: 'failed', detail: 'link_row_count' }]);
    expect(t.files.registerAvailable).toHaveBeenCalledTimes(1);
    expect(t.transactions).toEqual(['rollback']);
    expect(t.audit.record).not.toHaveBeenCalled();
    expect(t.files.readVerified).not.toHaveBeenCalled();
    expect(t.statements.some((s) => s.includes('SET avatar_key = NULL'))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('a link UPDATE that matches 2 rows is refused the same way', async () => {
    const t = setup({ link: 2, clear: 1 });
    const report = await run(t.command, [userItem()]);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', detail: 'link_row_count' });
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('a clear UPDATE that matches 0 rows: outcome failed (the legacy key is not reported cleared)', async () => {
    const t = setup({ link: 1, clear: 0 });
    const report = await run(t.command, [userItem()]);
    expect(report.results[0]).toMatchObject({ outcome: 'failed', detail: 'clear_row_count' });
    expect(t.transactions).toEqual(['commit', 'rollback']);
  });

  it('link and clear UPDATEs are conditional and each changes exactly one row: outcome migrated, one audit entry', async () => {
    const t = setup({ link: 1, clear: 1 });
    const report = await run(t.command, [userItem()]);
    expect(report.results[0]).toEqual({ table: 'user', rowId: USER, outcome: 'migrated', detail: 'file-1' });
    expect(t.audit.record).toHaveBeenCalledTimes(1);
    expect(t.statements.find((s) => s.includes('SET avatar_file_id'))).toMatch(/WHERE id = \$2 AND avatar_file_id IS NULL RETURNING id/);
    expect(t.statements.find((s) => s.includes('SET avatar_key = NULL'))).toMatch(/AND avatar_key IS NOT NULL AND avatar_file_id = \$2 RETURNING id/);
    expect(process.exitCode).toBe(0);
  });

  it('a manager_workspace logo is unsupported: nothing uploaded, registered, updated or audited; --apply exits 1', async () => {
    const t = setup({ link: 1, clear: 1 });
    const key = `org/${ORG}/logos/w.png`;
    mkdirSync(dirname(join(root, key)), { recursive: true });
    writeFileSync(join(root, key), PNG);
    const report = await run(t.command, [{ table: 'manager_workspace', rowId: WS, organisationId: ORG, workspaceId: WS, key, kind: FileKind.WORKSPACE_LOGO, resourceType: 'manager_workspace' }]);
    expect(report.results[0]).toMatchObject({ table: 'manager_workspace', rowId: WS, outcome: 'unsupported' });
    expect(t.files.putObject).not.toHaveBeenCalled();
    expect(t.files.registerAvailable).not.toHaveBeenCalled();
    expect(t.statements).toEqual([]);
    expect(t.audit.record).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('assertOneRow', () => {
  it('accepts exactly one changed row and refuses 0 or more than 1', () => {
    expect(() => assertOneRow([[{ id: 'a' }], 1], 'link')).not.toThrow();
    expect(() => assertOneRow([[], 0], 'link')).toThrow(/changed 0 rows/);
    expect(() => assertOneRow([[{}, {}], 2], 'clear')).toThrow(/changed 2 rows/);
    expect(() => assertOneRow(undefined, 'clear')).toThrow(/changed -1 rows/);
  });
});
