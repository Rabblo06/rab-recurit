import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { organisationIds } from '../../worker-shared/maintenance-catalogue';
import { TenantContextService } from '../tenant/tenant-context.service';
import { SecretEncryptionService } from './secret-encryption.service';

export type SecretClassification = 'active' | 'needs-rotation' | 'unreadable';

export interface SecretRecord {
  organisationId: string;
  classification: SecretClassification;
  kid?: string;
}

export interface RotationOutcome extends SecretRecord {
  action: 'rotated' | 'skipped-already-active' | 'skipped-concurrent-change' | 'skipped-unreadable';
}

/**
 * Checkpoint 3 (B3) — rotation tooling for SecretEncryptionService's versioned keyring. The only
 * confirmed live consumer, re-audited before writing this (not assumed from an earlier pass):
 * `core.platform_config.smtp_password_encrypted`. `core.user.totp_secret_encrypted` exists on the
 * entity but nothing in this codebase ever reads or writes it yet (MFA is unimplemented) — adding
 * it here would rotate a column that is always NULL in practice; it's deliberately left out until
 * MFA actually ships and writes real values, at which point this service's loop structure extends
 * to it trivially (same org-scoped table, same shape).
 *
 * `platform_config` is FORCE RLS and organisation-scoped (`organisation_id = core.current_org()`,
 * no workspace dimension) — ordinary `crewflow` has no cross-organisation bypass (it's the table's
 * owner, but FORCE binds the owner too for ordinary DML, confirmed live this same checkpoint
 * programme). This service never asks for one: it enumerates organisations via the existing
 * `worker_list_organisations` SECURITY DEFINER function (`organisationIds()`, already used by
 * worker maintenance jobs — reused here, not reimplemented) and processes each one inside
 * `TenantContextService.runInTenantContext`, exactly the pattern every other cross-org batch job
 * in this codebase already uses. No new grant, function, or migration needed.
 */
@Injectable()
export class SecretRotationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly secretEncryption: SecretEncryptionService,
  ) {}

  /** Reads and classifies every platform_config row with a non-null smtp_password_encrypted. Never yields the ciphertext or plaintext itself. */
  async *scan(): AsyncGenerator<SecretRecord> {
    for await (const organisationId of organisationIds(this.dataSource)) {
      const encrypted = await this.readOne(organisationId);
      if (!encrypted) continue;
      yield this.classify(organisationId, encrypted);
    }
  }

  /**
   * `dryRun: true` (default) performs the exact same read/classify/decrypt pass as a real rotation
   * but never writes — safe to run against any environment, including production, as many times as
   * wanted. `dryRun: false` re-encrypts every `needs-rotation` record under the active kid, using a
   * concurrency-guarded UPDATE (`WHERE ... AND smtp_password_encrypted = <bytes just read>`) so a
   * secret changed by an admin between this service's read and write is never clobbered — that row
   * is skipped, not overwritten, and will be correctly re-classified on the next run (idempotent
   * retry: there is no separate "rotation progress" state to corrupt or resume incorrectly from —
   * re-running this method after any interruption, for any reason, just re-does the same
   * read/classify/write decision fresh for every row).
   */
  async *rotate(options: { dryRun: boolean }): AsyncGenerator<RotationOutcome> {
    for await (const organisationId of organisationIds(this.dataSource)) {
      const encrypted = await this.readOne(organisationId);
      if (!encrypted) continue;
      const record = this.classify(organisationId, encrypted);

      if (record.classification === 'unreadable') {
        yield { ...record, action: 'skipped-unreadable' };
        continue;
      }
      if (record.classification === 'active') {
        yield { ...record, action: 'skipped-already-active' };
        continue;
      }
      if (options.dryRun) {
        yield { ...record, action: 'rotated' }; // "would rotate" — dry-run never writes
        continue;
      }

      const plaintext = this.secretEncryption.decrypt(encrypted);
      const reEncrypted = this.secretEncryption.encrypt(plaintext);
      const wrote = await this.writeIfUnchanged(organisationId, encrypted, reEncrypted);
      yield { ...record, action: wrote ? 'rotated' : 'skipped-concurrent-change' };
    }
  }

  /** Count of records not yet on the active kid — the gate for "safe to retire an old key" (B3.8: verify all records are readable/migrated first). */
  async countNeedingRotation(): Promise<{ total: number; needsRotation: number; unreadable: number }> {
    let total = 0;
    let needsRotation = 0;
    let unreadable = 0;
    for await (const record of this.scan()) {
      total += 1;
      if (record.classification === 'needs-rotation') needsRotation += 1;
      if (record.classification === 'unreadable') unreadable += 1;
    }
    return { total, needsRotation, unreadable };
  }

  private classify(organisationId: string, encrypted: Buffer): SecretRecord {
    try {
      const kid = this.secretEncryption.inspectKid(encrypted);
      // inspectKid alone proves the header parses, not that the ciphertext actually decrypts (wrong
      // key, tampering) — attempt the real decrypt so "unreadable" means genuinely unreadable.
      this.secretEncryption.decrypt(encrypted);
      return { organisationId, classification: kid === this.secretEncryption.currentActiveKid ? 'active' : 'needs-rotation', kid };
    } catch {
      return { organisationId, classification: 'unreadable' };
    }
  }

  private async readOne(organisationId: string): Promise<Buffer | undefined> {
    return runScopedForOrg(this.tenantContext, organisationId, null, async (manager) => {
      const rows = (await manager.query('SELECT smtp_password_encrypted FROM core.platform_config WHERE organisation_id = $1', [
        organisationId,
      ])) as Array<{ smtp_password_encrypted: Buffer | null }>;
      return rows[0]?.smtp_password_encrypted ?? undefined;
    });
  }

  private async writeIfUnchanged(organisationId: string, expectedCurrent: Buffer, next: Buffer): Promise<boolean> {
    return runScopedForOrg(this.tenantContext, organisationId, null, async (manager) => {
      // TypeORM's manager.query() returns a plain rows array for a SELECT, but a [rows, rowCount]
      // TUPLE for an UPDATE/INSERT/DELETE — including one with RETURNING — on the postgres driver.
      // Confirmed empirically (not assumed) with a standalone reproduction against this exact
      // transaction()-wrapped manager.query() pattern before fixing this: treating the tuple itself
      // as "the rows" made `.length` always 2, so this check always reported a false
      // skipped-concurrent-change even with zero actual concurrent writers.
      const result = await manager.query(
        `UPDATE core.platform_config SET smtp_password_encrypted = $1
          WHERE organisation_id = $2 AND smtp_password_encrypted = $3
          RETURNING organisation_id`,
        [next, organisationId, expectedCurrent],
      );
      const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as Array<{ organisation_id: string }>;
      return rows.length === 1;
    });
  }
}

// Local copy of rab-worker's runScopedForOrg helper's exact semantics (actorType 'worker': a system
// execution context, not a human — impersonates no Manager) — not importable here directly since
// rab-worker depends on rab-server, never the reverse; duplicating four lines is simpler and more
// honest than introducing a cross-package dependency cycle for them.
function runScopedForOrg<T>(
  tenantContext: TenantContextService,
  organisationId: string,
  workspaceId: string | null,
  fn: (manager: import('typeorm').EntityManager) => Promise<T>,
): Promise<T> {
  return tenantContext.runInTenantContext({ organisationId, workspaceId, userId: '', role: '', actorType: 'worker' }, fn);
}
