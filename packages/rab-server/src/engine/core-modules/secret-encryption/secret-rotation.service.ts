import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

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

// ------------------------------------------------------------------------------------------------ wave 5 (all columns)

/**
 * Every column `SecretEncryptionService` writes, re-audited for wave 5 (grep of `.encrypt(` callers + `_encrypted`
 * columns in core and every workspace template: none of these tables has a workspace copy):
 *   - `smtp_password`: `core.platform_config.smtp_password_encrypted` (AdminPanelService) — one row per organisation;
 *   - `push_token`:    `core.push_device.push_token_encrypted` (PushDeviceService) — many rows per organisation;
 *   - `totp_secret`:   `core.user.totp_secret_encrypted` (wave 4 MFA). `crewflow_app` cannot SELECT this column; the
 *                      ONLY read path is `core.mfa_totp_state(user_id)` (DB5 contract §1.3) and the ONLY write path for an
 *                      ENABLED secret is the requested `core.mfa_rotate_totp_secret(user_id, expected, next)` — until DB5
 *                      ships it, apply reports `skipped-unsupported` for TOTP rows and `--verify` stays NOT SAFE (fail
 *                      closed: a kid is never declared retirable while any TOTP row still uses it).
 */
export const ENCRYPTED_COLUMN_TARGETS = ['smtp_password', 'push_token', 'totp_secret'] as const;
export type EncryptedColumnTarget = (typeof ENCRYPTED_COLUMN_TARGETS)[number];

export type RowAction =
  | 'rotated'
  | 'would-rotate'
  | 'skipped-already-active'
  | 'skipped-concurrent-change'
  | 'skipped-unreadable'
  | 'skipped-unsupported';

export interface RowOutcome {
  target: EncryptedColumnTarget;
  organisationId: string;
  /** Row identifier only (organisation id / push_device id / user id) — never ciphertext or plaintext. */
  rowId: string;
  classification: SecretClassification;
  kid?: string;
  /** The stored value is not a RAB2 envelope (pre-Checkpoint-3 format): it violates DB5's envelope CHECK until rotated. */
  legacyEnvelope: boolean;
  action: RowAction;
}

export interface RotationCheckpoint {
  v: 1;
  activeKid: string;
  targets: EncryptedColumnTarget[];
  /** The next unit to process: rows of `target` in `organisationId` strictly after `cursor` (null = from the start). */
  position: { target: EncryptedColumnTarget; organisationId: string; cursor: string | null } | null;
  updatedAt: string;
}

export interface RotationCheckpointStore {
  load(): Promise<RotationCheckpoint | null>;
  save(checkpoint: RotationCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

export interface RotateAllOptions {
  dryRun: boolean;
  targets?: readonly EncryptedColumnTarget[];
  /** Rows read per transaction (1..1000, default 200). */
  batchSize?: number;
  /** Resume support: progress is saved after every committed batch; a run resumes from the saved position. */
  checkpoint?: RotationCheckpointStore;
  /** Stop cleanly (checkpoint saved) after this many rows were WRITTEN — staged rollouts and interruption tests. */
  maxRotations?: number;
  /** Stop cleanly (checkpoint saved) at the next batch boundary once aborted (SIGINT/SIGTERM in the command). */
  signal?: AbortSignal;
}

export interface TargetVerification {
  target: EncryptedColumnTarget;
  /** False when the column's read path does not exist on this database (e.g. MFA not migrated) — nothing to verify. */
  installed: boolean;
  /** False when rows of this target can be read but the rotation write path is missing (TOTP before DB5's function). */
  writable: boolean;
  total: number;
  active: number;
  needsRotation: number;
  unreadable: number;
  legacyEnvelope: number;
  byKid: Record<string, number>;
}

export interface VerificationReport {
  activeKid: string;
  targets: TargetVerification[];
  /** Every row of every installed target decrypts AND is a RAB2 envelope on the active kid. */
  allOnActiveKid: boolean;
  /** Present when `retireKid` was asked about. */
  retireKid?: { kid: string; safe: boolean; reasons: string[] };
  /** Row ids (never values) of unreadable rows, capped at 50 — tamper/corruption/unknown-kid evidence for an operator. */
  unreadableRows: Array<{ target: EncryptedColumnTarget; organisationId: string; rowId: string }>;
}

interface ReadRow {
  rowId: string;
  encrypted: Buffer;
}

interface ReadBatch {
  rows: ReadRow[];
  /** Cursor to continue from (last row id SCANNED, which for TOTP may be a user without a secret). Null = done. */
  next: string | null;
}

interface TargetAdapter {
  readonly name: EncryptedColumnTarget;
  installed(manager: EntityManager): Promise<boolean>;
  writable(manager: EntityManager): Promise<boolean>;
  readBatch(manager: EntityManager, organisationId: string, after: string | null, limit: number): Promise<ReadBatch>;
  writeIfUnchanged(manager: EntityManager, organisationId: string, rowId: string, expected: Buffer, next: Buffer): Promise<boolean>;
}

const RAB2_MAGIC = Buffer.from([0x52, 0x41, 0x42, 0x32]);
const DEFAULT_BATCH = 200;
const MAX_UNREADABLE_REPORTED = 50;

/** `manager.query` returns `[rows, rowCount]` for UPDATE … RETURNING on the postgres driver (see `writeIfUnchanged` below). */
function updatedRows<T>(result: unknown): T[] {
  return (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as T[];
}

async function functionExists(manager: EntityManager, signature: string): Promise<boolean> {
  const rows: Array<{ p: string | null }> = await manager.query('SELECT to_regprocedure($1)::text AS p', [signature]);
  return Boolean(rows[0]?.p);
}

const SMTP_ADAPTER: TargetAdapter = {
  name: 'smtp_password',
  installed: async () => true,
  writable: async () => true,
  async readBatch(manager, organisationId, after) {
    if (after !== null) return { rows: [], next: null }; // one row per organisation
    const rows: Array<{ smtp_password_encrypted: Buffer | null }> = await manager.query(
      'SELECT smtp_password_encrypted FROM core.platform_config WHERE organisation_id = $1',
      [organisationId],
    );
    const encrypted = rows[0]?.smtp_password_encrypted;
    return { rows: encrypted ? [{ rowId: organisationId, encrypted }] : [], next: null };
  },
  async writeIfUnchanged(manager, organisationId, _rowId, expected, next) {
    const result = await manager.query(
      `UPDATE core.platform_config SET smtp_password_encrypted = $1
        WHERE organisation_id = $2 AND smtp_password_encrypted = $3
        RETURNING organisation_id`,
      [next, organisationId, expected],
    );
    return updatedRows(result).length === 1;
  },
};

const PUSH_ADAPTER: TargetAdapter = {
  name: 'push_token',
  installed: async () => true,
  writable: async () => true,
  async readBatch(manager, organisationId, after, limit) {
    const rows: Array<{ id: string; push_token_encrypted: Buffer }> = await manager.query(
      `SELECT id, push_token_encrypted FROM core.push_device
        WHERE organisation_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
        ORDER BY id LIMIT $3`,
      [organisationId, after, limit],
    );
    return {
      rows: rows.map((r) => ({ rowId: r.id, encrypted: r.push_token_encrypted })),
      next: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  },
  async writeIfUnchanged(manager, organisationId, rowId, expected, next) {
    const result = await manager.query(
      `UPDATE core.push_device SET push_token_encrypted = $1
        WHERE id = $2 AND organisation_id = $3 AND push_token_encrypted = $4
        RETURNING id`,
      [next, rowId, organisationId, expected],
    );
    return updatedRows(result).length === 1;
  },
};

const TOTP_READ_FN = 'core.mfa_totp_state(uuid)';
/** Requested from lane DB5 (wave 5 OPS report): CAS replace of the ciphertext only; enabled/step/enabled_at untouched. */
const TOTP_ROTATE_FN = 'core.mfa_rotate_totp_secret(uuid,bytea,bytea)';

const TOTP_ADAPTER: TargetAdapter = {
  name: 'totp_secret',
  installed: (manager) => functionExists(manager, TOTP_READ_FN),
  writable: (manager) => functionExists(manager, TOTP_ROTATE_FN),
  async readBatch(manager, organisationId, after, limit) {
    // Users of the bound organisation (crewflow_app has column SELECT on id/organisation_id; core.user is RLS-bound).
    const users: Array<{ id: string }> = await manager.query(
      `SELECT id FROM core."user"
        WHERE organisation_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
        ORDER BY id LIMIT $3`,
      [organisationId, after, limit],
    );
    const rows: ReadRow[] = [];
    for (const user of users) {
      const state: Array<{ totp_secret_encrypted: Buffer | null }> = await manager.query(
        'SELECT totp_secret_encrypted FROM core.mfa_totp_state($1)',
        [user.id],
      );
      const encrypted = state[0]?.totp_secret_encrypted;
      if (encrypted) rows.push({ rowId: user.id, encrypted });
    }
    return { rows, next: users.length === limit ? users[users.length - 1]!.id : null };
  },
  async writeIfUnchanged(manager, _organisationId, rowId, expected, next) {
    const rows: Array<{ ok: boolean }> = await manager.query('SELECT core.mfa_rotate_totp_secret($1, $2, $3) AS ok', [rowId, expected, next]);
    return rows[0]?.ok === true;
  },
};

const ADAPTERS: Readonly<Record<EncryptedColumnTarget, TargetAdapter>> = {
  smtp_password: SMTP_ADAPTER,
  push_token: PUSH_ADAPTER,
  totp_secret: TOTP_ADAPTER,
};

/**
 * Rotation tooling for SecretEncryptionService's versioned keyring (`APP_ENCRYPTION_KEYRING` /
 * `APP_ENCRYPTION_ACTIVE_KID`; wave 2 lane A2's shared keyring parser).
 *
 * Wave 5 lane OPS: covers every encrypted column (`ENCRYPTED_COLUMN_TARGETS`), in bounded batches, resumable:
 *  - `rotateAll({ dryRun })` re-encrypts every readable row that is not a RAB2 envelope on the active kid. Every write is
 *    a compare-and-set on the exact bytes just read, so a value changed concurrently (a new SMTP password, a refreshed
 *    push token, a re-enrolled TOTP) is never clobbered — it is skipped and picked up by the next run.
 *  - Progress is checkpointed after every committed batch (ids only). Correctness never depends on the checkpoint — the
 *    pass is idempotent (rows already on the active kid are skipped) — it only avoids rescanning after an interruption.
 *    A checkpoint written under a different active kid is ignored.
 *  - Unreadable rows (unknown kid, truncated, GCM tag failure = tampered or wrong key) are never written and make
 *    `verify()` refuse.
 *  - `verify({ retireKid })` is the ONLY gate for removing a kid from the keyring: safe only when every installed target
 *    is fully readable, every row is a RAB2 envelope on the active kid, no row still uses `retireKid`, the target's write
 *    path exists, and `retireKid` is not the active kid. This service never edits the keyring itself.
 *
 * Organisations are enumerated through `core.worker_list_organisations` and each is processed inside
 * `TenantContextService.runInTenantContext` (actorType 'worker'), so RLS stays on for every read and write: no bypass,
 * no owner connection.
 *
 * Known limit (F6, not changed here): RAB2 has no AAD, so swapping two VALID ciphertexts between rows of the same column is
 * not detectable by decryption. RAB3 (AAD = table|column|row id) stays deferred (G7).
 */
@Injectable()
export class SecretRotationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly secretEncryption: SecretEncryptionService,
  ) {}

  // ---------------------------------------------------------------------------------------------- wave 5 API

  classifyBuffer(encrypted: Buffer): { classification: SecretClassification; kid?: string; legacyEnvelope: boolean } {
    const legacyEnvelope = !(encrypted.length >= RAB2_MAGIC.length && encrypted.subarray(0, RAB2_MAGIC.length).equals(RAB2_MAGIC));
    try {
      const kid = this.secretEncryption.inspectKid(encrypted);
      this.secretEncryption.decrypt(encrypted); // proves the GCM tag, not just the header
      const onActive = kid === this.secretEncryption.currentActiveKid && !legacyEnvelope;
      return { classification: onActive ? 'active' : 'needs-rotation', kid, legacyEnvelope };
    } catch {
      return { classification: 'unreadable', legacyEnvelope };
    }
  }

  async *rotateAll(options: RotateAllOptions): AsyncGenerator<RowOutcome> {
    const targets = [...(options.targets ?? ENCRYPTED_COLUMN_TARGETS)];
    const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? DEFAULT_BATCH), 1), 1000);
    const activeKid = this.secretEncryption.currentActiveKid;
    let resume = options.dryRun ? null : ((await options.checkpoint?.load()) ?? null);
    if (resume && (resume.activeKid !== activeKid || resume.v !== 1)) resume = null; // a different rotation: start over
    let rotations = 0;

    const save = async (position: RotationCheckpoint['position']) => {
      if (options.dryRun || !options.checkpoint) return;
      await options.checkpoint.save({ v: 1, activeKid, targets, position, updatedAt: new Date().toISOString() });
    };

    const resumeTargetIndex = resume?.position ? targets.indexOf(resume.position.target) : -1;
    for (let t = 0; t < targets.length; t++) {
      const adapter = ADAPTERS[targets[t]!];
      if (resumeTargetIndex > t) continue;
      const installed = await this.withSystemContext((m) => adapter.installed(m));
      if (!installed) continue;
      const writable = await this.withSystemContext((m) => adapter.writable(m));

      for await (const organisationId of organisationIds(this.dataSource)) {
        let cursor: string | null = null;
        if (resume?.position && resumeTargetIndex === t) {
          if (organisationId < resume.position.organisationId) continue;
          if (organisationId === resume.position.organisationId) cursor = resume.position.cursor;
        }
        for (;;) {
          if (options.signal?.aborted) {
            await save({ target: adapter.name, organisationId, cursor });
            return;
          }
          const batchCursor: string | null = cursor;
          const { outcomes, next, stopAt } = await this.runScopedForOrg(organisationId, async (manager): Promise<{ outcomes: RowOutcome[]; next: string | null; stopAt: string | null | undefined }> => {
            const batch = await adapter.readBatch(manager, organisationId, batchCursor, batchSize);
            const results: RowOutcome[] = [];
            for (const row of batch.rows) {
              const c = this.classifyBuffer(row.encrypted);
              const base = { target: adapter.name, organisationId, rowId: row.rowId, classification: c.classification, kid: c.kid, legacyEnvelope: c.legacyEnvelope };
              if (c.classification === 'unreadable') results.push({ ...base, action: 'skipped-unreadable' });
              else if (c.classification === 'active') results.push({ ...base, action: 'skipped-already-active' });
              else if (options.dryRun) results.push({ ...base, action: 'would-rotate' });
              else if (!writable) results.push({ ...base, action: 'skipped-unsupported' });
              else if (options.maxRotations !== undefined && rotations >= options.maxRotations) break;
              else {
                const next = this.secretEncryption.encrypt(this.secretEncryption.decrypt(row.encrypted));
                const wrote = await adapter.writeIfUnchanged(manager, organisationId, row.rowId, row.encrypted, next);
                if (wrote) rotations += 1;
                results.push({ ...base, action: wrote ? 'rotated' : 'skipped-concurrent-change' });
              }
            }
            // Stopped part-way by maxRotations: resume from the last row actually handled in this batch.
            const stoppedEarly = results.length < batch.rows.length;
            const lastHandled = results.length > 0 ? results[results.length - 1]!.rowId : batchCursor;
            return { outcomes: results, next: batch.next, stopAt: stoppedEarly ? lastHandled : undefined };
          });
          for (const outcome of outcomes) yield outcome;
          if (stopAt !== undefined) {
            await save({ target: adapter.name, organisationId, cursor: stopAt });
            return;
          }
          cursor = next;
          if (cursor === null) break;
          await save({ target: adapter.name, organisationId, cursor });
          if (options.maxRotations !== undefined && rotations >= options.maxRotations) {
            return;
          }
        }
        // Organisation finished: the next position is the following organisation (saved lazily as "after this one").
        await save({ target: adapter.name, organisationId: nextUuid(organisationId), cursor: null });
        if (options.maxRotations !== undefined && rotations >= options.maxRotations) return;
      }
      if (t + 1 < targets.length) await save({ target: targets[t + 1]!, organisationId: '00000000-0000-0000-0000-000000000000', cursor: null });
    }
    if (!options.dryRun) await options.checkpoint?.clear();
  }

  async verify(options: { targets?: readonly EncryptedColumnTarget[]; retireKid?: string } = {}): Promise<VerificationReport> {
    const activeKid = this.secretEncryption.currentActiveKid;
    const reports: TargetVerification[] = [];
    const unreadableRows: VerificationReport['unreadableRows'] = [];
    for (const name of options.targets ?? ENCRYPTED_COLUMN_TARGETS) {
      const adapter = ADAPTERS[name];
      const installed = await this.withSystemContext((m) => adapter.installed(m));
      const writable = installed ? await this.withSystemContext((m) => adapter.writable(m)) : false;
      const report: TargetVerification = { target: name, installed, writable, total: 0, active: 0, needsRotation: 0, unreadable: 0, legacyEnvelope: 0, byKid: {} };
      if (installed) {
        for await (const organisationId of organisationIds(this.dataSource)) {
          let cursor: string | null = null;
          for (;;) {
            const after: string | null = cursor;
            const batch: ReadBatch = await this.runScopedForOrg(organisationId, (m): Promise<ReadBatch> => adapter.readBatch(m, organisationId, after, DEFAULT_BATCH));
            for (const row of batch.rows) {
              const c = this.classifyBuffer(row.encrypted);
              report.total += 1;
              if (c.legacyEnvelope) report.legacyEnvelope += 1;
              if (c.classification === 'unreadable') {
                report.unreadable += 1;
                if (unreadableRows.length < MAX_UNREADABLE_REPORTED) unreadableRows.push({ target: name, organisationId, rowId: row.rowId });
                continue;
              }
              report.byKid[c.kid!] = (report.byKid[c.kid!] ?? 0) + 1;
              if (c.classification === 'active') report.active += 1;
              else report.needsRotation += 1;
            }
            cursor = batch.next;
            if (cursor === null) break;
          }
        }
      }
      reports.push(report);
    }
    const allOnActiveKid = reports.every((r) => !r.installed || (r.unreadable === 0 && r.needsRotation === 0));
    const result: VerificationReport = { activeKid, targets: reports, allOnActiveKid, unreadableRows };
    if (options.retireKid !== undefined) {
      const kid = options.retireKid;
      const reasons: string[] = [];
      if (kid === activeKid) reasons.push(`"${kid}" is the ACTIVE kid`);
      if (!this.secretEncryption.getKeyringSummary().kids.includes(kid)) reasons.push(`"${kid}" is not in this process's keyring (nothing to retire, or the wrong keyring is loaded)`);
      for (const r of reports) {
        if (!r.installed) continue;
        if (r.unreadable > 0) reasons.push(`${r.target}: ${r.unreadable} unreadable row(s)`);
        if (r.needsRotation > 0) reasons.push(`${r.target}: ${r.needsRotation} row(s) not on the active kid`);
        if ((r.byKid[kid] ?? 0) > 0) reasons.push(`${r.target}: ${r.byKid[kid]} row(s) still encrypted under "${kid}"`);
        if (!r.writable && r.total > 0) reasons.push(`${r.target}: rotation write path missing on this database`);
      }
      result.retireKid = { kid, safe: reasons.length === 0, reasons };
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------------- legacy (smtp only)

  /** Reads and classifies every platform_config row with a non-null smtp_password_encrypted. Never yields the ciphertext or plaintext itself. */
  async *scan(): AsyncGenerator<SecretRecord> {
    for await (const organisationId of organisationIds(this.dataSource)) {
      const encrypted = await this.readOne(organisationId);
      if (!encrypted) continue;
      yield this.classify(organisationId, encrypted);
    }
  }

  /**
   * SMTP-only pass (the original Checkpoint 3 API, kept for its callers/tests). `rotateAll` is the wave-5 entry point the
   * `secret:rotate` command uses. Same compare-and-set semantics.
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

  /** SMTP-only count (legacy API). The wave-5 gate is `verify()`. */
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
    const c = this.classifyBuffer(encrypted);
    return c.classification === 'unreadable' ? { organisationId, classification: 'unreadable' } : { organisationId, classification: c.classification, kid: c.kid };
  }

  private async readOne(organisationId: string): Promise<Buffer | undefined> {
    return this.runScopedForOrg(organisationId, async (manager) => {
      const batch = await SMTP_ADAPTER.readBatch(manager, organisationId, null, 1);
      return batch.rows[0]?.encrypted;
    });
  }

  private async writeIfUnchanged(organisationId: string, expectedCurrent: Buffer, next: Buffer): Promise<boolean> {
    return this.runScopedForOrg(organisationId, (manager) => SMTP_ADAPTER.writeIfUnchanged(manager, organisationId, organisationId, expectedCurrent, next));
  }

  // Local copy of rab-worker's runScopedForOrg helper's exact semantics (actorType 'worker': a system execution context, not
  // a human — impersonates no Manager). rab-worker depends on rab-server, never the reverse.
  private runScopedForOrg<T>(organisationId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '', actorType: 'worker' }, fn);
  }

  /** Catalogue-only probes (`to_regprocedure`) — no tenant data is read. */
  private withSystemContext<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.tenantContext.runInTenantContext({ organisationId: null, workspaceId: null, userId: '', role: '', actorType: 'worker' }, fn);
  }
}

/** The smallest UUID strictly greater than `id` in PostgreSQL's (bytewise == lowercase-hex) uuid order. */
function nextUuid(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  let n = BigInt(`0x${hex}`) + 1n;
  if (n >= 1n << 128n) n = (1n << 128n) - 1n;
  const out = n.toString(16).padStart(32, '0');
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}
