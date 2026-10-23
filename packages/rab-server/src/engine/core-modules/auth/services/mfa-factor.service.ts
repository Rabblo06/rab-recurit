import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { SecretEncryptionService } from '../../secret-encryption/secret-encryption.service';
import { MfaStore, MfaTotpState } from '../mfa/mfa-store';
import { generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode } from '../mfa/recovery-codes';
import { generateTotpSecret, normaliseTotpInput, verifyTotp } from '../mfa/totp';
import { LoginAttemptLimiterService } from './login-attempt-limiter.service';

export type VerifiedFactor = { method: 'totp' } | { method: 'recovery_code'; recoveryCodesRemaining: number };

/**
 * Wave 4 lane MFA — the low-level second-factor primitives every flow shares (sign-in challenge, enrolment, step-up,
 * disable, regenerate, admin reset), so replay protection and recovery-code single use can never differ between them.
 *
 * Every method takes an `EntityManager` already bound to the TARGET user's organisation (`MfaStore` reads the tenant from
 * `core.current_org()`).
 *
 * IMPORTANT — commit semantics: `verify()` burns the TOTP step / recovery code in the caller's transaction. Callers run it
 * in a transaction of its own that COMMITS before anything else can fail (see `MfaLoginService.verifyChallenge`), so a code
 * that was accepted once is burned even if the rest of the flow is refused afterwards.
 */
@Injectable()
export class MfaFactorService {
  private readonly logger = new Logger(MfaFactorService.name);

  constructor(
    private readonly store: MfaStore,
    private readonly encryption: SecretEncryptionService,
    private readonly limiter: LoginAttemptLimiterService,
  ) {}

  state(manager: EntityManager, userId: string): Promise<MfaTotpState | null> {
    return this.store.state(manager, userId);
  }

  /** Per-user attempt bucket (429 / fail-closed 503). Call once per presented code, BEFORE checking it. */
  admitAttempt(userId: string): Promise<void> {
    return this.limiter.admitSecondFactor(userId);
  }

  /**
   * Checks a presented TOTP code (±1 step, replay-protected through DB5's atomic `mfa_accept_totp_step`: the same step,
   * or any older one, is refused) or — when `allowRecoveryCode` — a one-time recovery code (atomic single use). Returns
   * null for anything else, including an account with no enabled factor. Never logs the code or the secret.
   */
  async verify(manager: EntityManager, userId: string, input: unknown, opts: { allowRecoveryCode: boolean; nowMs?: number }): Promise<VerifiedFactor | null> {
    const state = await this.store.state(manager, userId);
    if (!state?.totpEnabled || !state.secretEncrypted) return null;

    const totp = normaliseTotpInput(input);
    if (totp) {
      const secret = this.decryptSecret(state.secretEncrypted);
      const step = verifyTotp(secret, totp, opts.nowMs ?? Date.now());
      if (step === null) return null;
      // Cheap early refusal; the conditional UPDATE inside mfa_accept_totp_step is the authority (parallel replays).
      if (state.lastUsedStep !== null && step <= state.lastUsedStep) return null;
      return (await this.store.acceptStep(manager, userId, step)) ? { method: 'totp' } : null;
    }

    if (opts.allowRecoveryCode) {
      const recovery = normaliseRecoveryCode(input);
      if (recovery && (await this.store.consumeRecoveryCode(manager, userId, hashRecoveryCode(recovery)))) {
        return { method: 'recovery_code', recoveryCodesRemaining: Math.max(0, state.recoveryCodesRemaining - 1) };
      }
    }
    return null;
  }

  /** Generates a new secret, stages it (only possible while MFA is not enabled) and returns the raw secret once. */
  async stageNewSecret(manager: EntityManager, userId: string): Promise<Buffer | null> {
    const secret = generateTotpSecret();
    const staged = await this.store.stage(manager, userId, this.encryption.encrypt(secret.toString('hex')));
    return staged ? secret : null;
  }

  /**
   * Confirms enrolment: the code must match the STAGED secret. Stores ten fresh recovery codes (hashed) and enables MFA
   * with the confirming step recorded, in the caller's transaction. Returns the clear codes (shown once) or null.
   */
  async confirmEnrolment(manager: EntityManager, userId: string, input: unknown, nowMs = Date.now()): Promise<string[] | null> {
    const state = await this.store.state(manager, userId);
    if (!state || state.totpEnabled || !state.secretEncrypted) return null;
    const code = normaliseTotpInput(input);
    if (!code) return null;
    const step = verifyTotp(this.decryptSecret(state.secretEncrypted), code, nowMs);
    if (step === null) return null;
    const codes = generateRecoveryCodes();
    const stored = await this.store.replaceRecoveryCodes(manager, userId, codes.map((c) => hashRecoveryCode(normaliseRecoveryCode(c)!)));
    if (stored !== codes.length) throw new Error('mfa: recovery codes were not stored');
    if (!(await this.store.enable(manager, userId, step))) return null;
    return codes;
  }

  /** Replaces the recovery-code set (regeneration after step-up). Returns the clear codes (shown once). */
  async regenerateRecoveryCodes(manager: EntityManager, userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    const stored = await this.store.replaceRecoveryCodes(manager, userId, codes.map((c) => hashRecoveryCode(normaliseRecoveryCode(c)!)));
    if (stored !== codes.length) throw new Error('mfa: recovery codes were not stored');
    return codes;
  }

  disable(manager: EntityManager, userId: string): Promise<boolean> {
    return this.store.disable(manager, userId);
  }

  private decryptSecret(encrypted: Buffer): Buffer {
    const hex = this.encryption.decrypt(encrypted);
    if (!/^[0-9a-f]{40}$/.test(hex)) {
      // Never log the value — only that the stored envelope does not hold a well-formed secret.
      this.logger.error('mfa: stored TOTP secret is malformed');
      throw new Error('mfa: stored TOTP secret is malformed');
    }
    return Buffer.from(hex, 'hex');
  }
}
