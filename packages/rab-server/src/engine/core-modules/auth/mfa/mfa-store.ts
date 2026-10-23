import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface MfaTotpState {
  totpEnabled: boolean;
  /** RAB2 envelope (SecretEncryptionService). Staged-but-unconfirmed when `totpEnabled` is false. */
  secretEncrypted: Buffer | null;
  lastUsedStep: number | null;
  enabledAt: Date | null;
  recoveryCodesRemaining: number;
}

/**
 * Wave 4 lane MFA — the ONLY place the MFA schema of lane DB5 (`docs/evidence/w45-db5/CONTRACT.md` §1,
 * `MfaTotpRecoveryCodes1786719900000`) is touched. Every function is SECURITY DEFINER, EXECUTE `crewflow_app` only, and
 * reads the tenant from `core.current_org()` — so every method takes an `EntityManager` that is ALREADY inside
 * `TenantContextService.runInTenantContext` for the target user's organisation (never a parameter). Unknown user / other
 * tenant / wrong state all come back as "no row" / `false`.
 *
 * The `crewflow_app` role cannot read `totp_secret_encrypted` or any recovery-code hash directly (column/table
 * privileges), and a guard trigger refuses any direct write to the MFA columns (SQLSTATE 42501): disabling MFA or
 * rewinding the replay counter with a plain UPDATE is impossible even for application code.
 */
@Injectable()
export class MfaStore {
  async state(manager: EntityManager, userId: string): Promise<MfaTotpState | null> {
    const rows = await manager.query<
      Array<{ totp_enabled: boolean; totp_secret_encrypted: Buffer | null; totp_last_used_step: string | number | null; mfa_enabled_at: Date | null; recovery_codes_remaining: number }>
    >('SELECT * FROM core.mfa_totp_state($1::uuid)', [userId]);
    const row = rows[0];
    if (!row) return null;
    return {
      totpEnabled: row.totp_enabled === true,
      secretEncrypted: row.totp_secret_encrypted ?? null,
      lastUsedStep: row.totp_last_used_step === null || row.totp_last_used_step === undefined ? null : Number(row.totp_last_used_step),
      enabledAt: row.mfa_enabled_at ? new Date(row.mfa_enabled_at) : null,
      recoveryCodesRemaining: Number(row.recovery_codes_remaining ?? 0),
    };
  }

  /** Only while MFA is NOT enabled: stores (replaces) the staged secret and clears the replay counter. */
  async stage(manager: EntityManager, userId: string, secretEncrypted: Buffer): Promise<boolean> {
    return this.bool(manager, 'SELECT core.mfa_stage_totp_secret($1::uuid, $2::bytea) AS ok', [userId, secretEncrypted]);
  }

  /** Staged + not enabled → enabled, with the confirming code's step recorded (it can never be replayed). */
  async enable(manager: EntityManager, userId: string, step: number): Promise<boolean> {
    return this.bool(manager, 'SELECT core.mfa_enable_totp($1::uuid, $2::bigint) AS ok', [userId, step]);
  }

  /** Atomic replay protection: true iff enabled AND the step is strictly newer than the last accepted one. */
  async acceptStep(manager: EntityManager, userId: string, step: number): Promise<boolean> {
    return this.bool(manager, 'SELECT core.mfa_accept_totp_step($1::uuid, $2::bigint) AS ok', [userId, step]);
  }

  async disable(manager: EntityManager, userId: string): Promise<boolean> {
    return this.bool(manager, 'SELECT core.mfa_disable($1::uuid) AS ok', [userId]);
  }

  /** Replaces the whole set (1..20 distinct hex64 hashes). Requires a staged or enabled secret. Returns codes stored. */
  async replaceRecoveryCodes(manager: EntityManager, userId: string, hashes: string[]): Promise<number> {
    const rows = await manager.query<Array<{ n: number }>>('SELECT core.mfa_replace_recovery_codes($1::uuid, $2::text[]) AS n', [userId, hashes]);
    return Number(rows[0]?.n ?? 0);
  }

  /** Atomic single use. */
  async consumeRecoveryCode(manager: EntityManager, userId: string, hash: string): Promise<boolean> {
    return this.bool(manager, 'SELECT core.mfa_consume_recovery_code($1::uuid, $2::text) AS ok', [userId, hash]);
  }

  private async bool(manager: EntityManager, sql: string, params: unknown[]): Promise<boolean> {
    const rows = await manager.query<Array<{ ok: boolean | null }>>(sql, params);
    return rows[0]?.ok === true;
  }
}
