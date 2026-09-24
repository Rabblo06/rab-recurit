import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { writeFileSync } from 'node:fs';

import { Command, CommandRunner, Option } from 'nest-commander';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../engine/core-modules/audit/audit.service';
import { EnvironmentService } from '../engine/core-modules/environment/environment.service';
import { FileKind, FileKindType } from '../engine/core-modules/storage/file-kinds';
import { FileService } from '../engine/core-modules/storage/file.service';
import { StorageDriverFactory } from '../engine/core-modules/storage/storage-driver.factory';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';

interface Options {
  source?: string;
  apply?: boolean;
  reportFile?: string;
}

interface Legacy {
  table: 'user' | 'organisation' | 'manager_workspace';
  rowId: string;
  organisationId: string;
  workspaceId: string | null;
  key: string;
  kind: FileKindType;
  resourceType: string;
}

type Outcome = 'would_migrate' | 'migrated' | 'source_missing' | 'invalid_key' | 'key_owner_mismatch' | 'invalid_content' | 'failed';

/**
 * `storage:migrate-local` — moves files that live on a container's local disk
 * (legacy `avatar_key` / `logo_key` columns) into the configured S3 store and
 * points the owning row at a `stored_file`.
 *
 * DRY-RUN BY DEFAULT: nothing is uploaded or changed without `--apply`.
 *
 * Safety rules (each one is a test):
 *   - Ownership comes from the DATABASE row that references the file, never
 *     from the file's name or path. A key whose `org/<id>/` segment differs
 *     from the referencing row's organisation is REJECTED, not migrated.
 *   - The key must resolve inside `--source`; traversal is rejected.
 *   - Content is re-validated by magic bytes for the kind before upload.
 *   - Upload -> HEAD-verify -> register -> link -> READ BACK and verify
 *     SHA-256 -> only then is the legacy key column cleared.
 *   - Idempotent: rows already linked to a file id are skipped, a re-run
 *     migrates only what is left.
 *   - The local original is NEVER deleted.
 *   - Local files that no database row references are not touched; the
 *     report lists none because discovery is DB-driven by design.
 */
@Command({ name: 'storage:migrate-local', description: 'Migrate locally stored avatars/logos to the configured S3 store (dry-run unless --apply)' })
export class StorageMigrateLocalCommand extends CommandRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly files: FileService,
    private readonly drivers: StorageDriverFactory,
    private readonly audit: AuditService,
    private readonly env: EnvironmentService,
  ) {
    super();
  }

  @Option({ flags: '--source <dir>', description: 'Local storage root to read from (default: STORAGE_LOCAL_ROOT)' })
  parseSource(value: string): string {
    return value;
  }

  @Option({ flags: '--apply', description: 'Actually upload and link. Without it this is a dry run.' })
  parseApply(): boolean {
    return true;
  }

  @Option({ flags: '--report-file <path>', description: 'Write the JSON report here' })
  parseReportFile(value: string): string {
    return value;
  }

  async run(_params: string[], options: Options): Promise<void> {
    const driver = this.drivers.getDriver();
    if (options.apply && driver.name !== 'S3') {
      throw new Error('Refusing to migrate: STORAGE_DRIVER is not S3, so there is no shared store to migrate INTO.');
    }
    const root = resolve(options.source ?? this.env.get('STORAGE_LOCAL_ROOT'));
    const legacy = await this.discover();
    const results: Array<{ table: string; rowId: string; outcome: Outcome; detail?: string }> = [];

    for (const item of legacy) {
      results.push({ table: item.table, rowId: item.rowId, ...(await this.migrateOne(item, root, Boolean(options.apply))) });
    }

    const summary = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
    const json = JSON.stringify({ mode: options.apply ? 'APPLY' : 'DRY-RUN', source: root, candidates: legacy.length, summary, results }, null, 2);
    if (options.reportFile) writeFileSync(options.reportFile, json);
    // eslint-disable-next-line no-console
    console.log(json);
    if (results.some((r) => r.outcome === 'failed')) process.exitCode = 1;
  }

  /** DB-driven discovery: only rows that still hold a legacy key and have no file id. `user`, `organisation` and `manager_workspace` are not FORCE'd, so the owner connection sees every tenant. */
  private async discover(): Promise<Legacy[]> {
    const users = await this.dataSource.query(`SELECT id, organisation_id, avatar_key AS key FROM core."user" WHERE avatar_key IS NOT NULL AND avatar_file_id IS NULL`);
    const orgs = await this.dataSource.query(`SELECT id, id AS organisation_id, logo_key AS key FROM core.organisation WHERE logo_key IS NOT NULL AND logo_file_id IS NULL`);
    const workspaces = await this.dataSource.query(`SELECT id, organisation_id, logo_key AS key FROM core.manager_workspace WHERE logo_key IS NOT NULL AND logo_file_id IS NULL`);
    return [
      ...users.map((r: { id: string; organisation_id: string; key: string }): Legacy => ({ table: 'user', rowId: r.id, organisationId: r.organisation_id, workspaceId: null, key: r.key, kind: FileKind.PROFILE_IMAGE, resourceType: 'user' })),
      ...orgs.map((r: { id: string; organisation_id: string; key: string }): Legacy => ({ table: 'organisation', rowId: r.id, organisationId: r.organisation_id, workspaceId: null, key: r.key, kind: FileKind.ORGANISATION_LOGO, resourceType: 'organisation' })),
      ...workspaces.map((r: { id: string; organisation_id: string; key: string }): Legacy => ({ table: 'manager_workspace', rowId: r.id, organisationId: r.organisation_id, workspaceId: r.id, key: r.key, kind: FileKind.WORKSPACE_LOGO, resourceType: 'manager_workspace' })),
    ];
  }

  private async migrateOne(item: Legacy, root: string, apply: boolean): Promise<{ outcome: Outcome; detail?: string }> {
    // 1. The key must be inside the source root and belong to the SAME organisation as the referencing row.
    const full = resolve(root, item.key);
    if (item.key.includes('..') || !full.startsWith(`${root}${sep}`)) return { outcome: 'invalid_key' };
    if (!item.key.startsWith(`org/${item.organisationId}/`)) return { outcome: 'key_owner_mismatch' };

    // 2. The file must exist and be valid content for its kind.
    let bytes: Buffer;
    try {
      await stat(full);
      bytes = await readFile(full);
    } catch {
      return { outcome: 'source_missing' };
    }
    try {
      this.files.validateContent(item.kind, bytes);
    } catch {
      return { outcome: 'invalid_content' };
    }
    if (!apply) return { outcome: 'would_migrate' };

    try {
      const uploaded = await this.files.putObject({
        kind: item.kind,
        organisationId: item.organisationId,
        workspaceId: item.workspaceId,
        resourceType: item.resourceType,
        resourceId: item.rowId,
        buffer: bytes,
        filename: item.key.split('/').pop(),
      });
      const ctx = { organisationId: item.organisationId, workspaceId: item.workspaceId, userId: '', role: '' };
      const fileId = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const file = await this.files.registerAvailable(manager, uploaded);
        const column = item.table === 'user' ? 'avatar_file_id' : 'logo_file_id';
        const table = item.table === 'user' ? 'core."user"' : `core.${item.table}`;
        await manager.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [file.id, item.rowId]);
        await this.audit.record(manager, { organisationId: item.organisationId, userId: '', inspectedBy: undefined }, AuditAction.FILE_MIGRATION_COMPLETED, {
          entityType: 'stored_file',
          entityId: file.id,
          metadata: { table: item.table, sizeBytes: file.sizeBytes },
          actorUserId: null,
        });
        return file.id;
      });
      // 3. Read it back through the same verified path clients use; only then retire the legacy key.
      await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        const file = await this.files.findAvailable(manager, fileId);
        if (!file) throw new Error('migrated file not readable');
        await this.files.readVerified(file);
        const table = item.table === 'user' ? 'core."user"' : `core.${item.table}`;
        const keyColumn = item.table === 'user' ? 'avatar_key' : 'logo_key';
        await manager.query(`UPDATE ${table} SET ${keyColumn} = NULL WHERE id = $1`, [item.rowId]);
      });
      return { outcome: 'migrated', detail: fileId };
    } catch (error) {
      return { outcome: 'failed', detail: (error as { code?: string }).code ?? 'error' };
    }
  }
}
