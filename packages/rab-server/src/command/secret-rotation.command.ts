import { Command, CommandRunner, Option } from 'nest-commander';

import { AccessTokenService } from '../engine/core-modules/auth/token/services/access-token.service';
import { SecretEncryptionService } from '../engine/core-modules/secret-encryption/secret-encryption.service';
import { SecretRotationService } from '../engine/core-modules/secret-encryption/secret-rotation.service';

interface Options {
  dryRun?: boolean;
  apply?: boolean;
  verify?: boolean;
  checkKeyring?: boolean;
}

/**
 * `secret:rotate` — Checkpoint 3 (B3) rotation tooling for SecretEncryptionService's versioned
 * keyring (`APP_ENCRYPTION_KEYRING`/`APP_ENCRYPTION_ACTIVE_KID`). Scope confirmed by a fresh repo
 * audit at the time this command was written: the only live encrypted column is
 * `core.platform_config.smtp_password_encrypted` — see `SecretRotationService`'s own doc comment
 * for why `core.user.totp_secret_encrypted` is excluded.
 *
 * Never prints plaintext, keys, raw ciphertext, SMTP credentials, or a database URL — every line
 * below is built from organisation ids, counts and classification labels only.
 *
 * Modes (mutually exclusive; `--dry-run` is the default — report-only, zero writes):
 *   --dry-run       report what rotation WOULD do — classification counts, zero writes
 *   --apply         writes re-encrypted ciphertext for every `needs-rotation` record (concurrency-
 *                   guarded; idempotent — re-running after an interruption just continues)
 *   --verify        reports whether ANY record still needs rotation or is unreadable — the gate
 *                   for "safe to retire a key from the keyring" (exits non-zero if not)
 *   --check-keyring P2.4 — prints THIS process's resolved `activeKid`/known kids for both
 *                   `SecretEncryptionService` and `AccessTokenService`, never key material. The
 *                   multi-instance rollout runbook (`docs/HANDOFF.md`, "Key rotation — multi-
 *                   instance rollout") has an operator run this against EVERY live instance
 *                   before flipping `APP_ENCRYPTION_ACTIVE_KID`/`APP_JWT_ACTIVE_KID`: every
 *                   instance must already report the NEW kid as present (even while still
 *                   reporting the OLD kid as active) before the flip, so no instance is ever
 *                   asked to verify/decrypt a kid it doesn't have yet.
 *
 * `DB_TARGET` and the production-command safeguards already run globally in `command/main.ts`'s
 * `bootstrap()` before this command's `run()` — nothing extra needed here. Unlike
 * `user-session:backfill`, this command needs NO `DATABASE_URL_UNPOOLED` / owner connection:
 * `platform_config` is an ordinary FORCE-RLS `crewflow`-owned table, and `SecretRotationService`
 * reaches every organisation's row through the same per-organisation `TenantContextService`
 * binding every other cross-org batch job in this codebase already uses.
 */
@Command({
  name: 'secret:rotate',
  description: 'Inspect or rotate SecretEncryptionService-encrypted records to the active keyring entry (dry-run by default)',
})
export class SecretRotationCommand extends CommandRunner {
  constructor(
    private readonly rotation: SecretRotationService,
    private readonly secretEncryption: SecretEncryptionService,
    private readonly accessToken: AccessTokenService,
  ) {
    super();
  }

  @Option({ flags: '--dry-run', description: 'Report what rotation would do, zero writes (default if no mode flag is given)' })
  parseDryRun(): boolean {
    return true;
  }

  @Option({ flags: '--apply', description: 'MODIFIES: re-encrypt every needs-rotation record under the active key' })
  parseApply(): boolean {
    return true;
  }

  @Option({ flags: '--verify', description: 'Report whether any record still needs rotation or is unreadable; no writes' })
  parseVerify(): boolean {
    return true;
  }

  @Option({ flags: '--check-keyring', description: "Report this process's resolved encryption/JWT keyring kids (never key material); no writes" })
  parseCheckKeyring(): boolean {
    return true;
  }

  async run(_params: string[], options: Options): Promise<void> {
    const modesRequested = [options.dryRun, options.apply, options.verify, options.checkKeyring].filter(Boolean).length;
    if (modesRequested > 1) throw new Error('--dry-run, --apply, --verify and --check-keyring are mutually exclusive — pass exactly one.');
    const mode: 'dry-run' | 'apply' | 'verify' | 'check-keyring' = options.checkKeyring
      ? 'check-keyring'
      : options.verify
        ? 'verify'
        : options.apply
          ? 'apply'
          : 'dry-run';

    // eslint-disable-next-line no-console
    console.log(`[secret:rotate] mode=${mode}`);

    if (mode === 'check-keyring') {
      const encryption = this.secretEncryption.getKeyringSummary();
      const jwt = this.accessToken.getKeyringSummary();
      // eslint-disable-next-line no-console
      console.log(`  SecretEncryptionService: activeKid=${encryption.activeKid} kids=[${encryption.kids.join(', ')}]`);
      // eslint-disable-next-line no-console
      console.log(`  AccessTokenService:      activeKid=${jwt.activeKid} kids=[${jwt.kids.join(', ')}]`);
      return;
    }

    if (mode === 'verify') {
      const result = await this.rotation.countNeedingRotation();
      // eslint-disable-next-line no-console
      console.log(`  total=${result.total} needsRotation=${result.needsRotation} unreadable=${result.unreadable}`);
      if (result.needsRotation > 0 || result.unreadable > 0) {
        // eslint-disable-next-line no-console
        console.error('  NOT SAFE to retire an old key yet — records remain that are not on the active key or are unreadable.');
        process.exitCode = 1;
      } else {
        // eslint-disable-next-line no-console
        console.log('  SAFE to retire any key not currently marked active — every record is readable and on the active key.');
      }
      return;
    }

    const counts = { rotated: 0, skippedAlreadyActive: 0, skippedConcurrentChange: 0, skippedUnreadable: 0 };
    const unreadableOrgs: string[] = [];
    for await (const outcome of this.rotation.rotate({ dryRun: mode === 'dry-run' })) {
      switch (outcome.action) {
        case 'rotated':
          counts.rotated += 1;
          break;
        case 'skipped-already-active':
          counts.skippedAlreadyActive += 1;
          break;
        case 'skipped-concurrent-change':
          counts.skippedConcurrentChange += 1;
          break;
        case 'skipped-unreadable':
          counts.skippedUnreadable += 1;
          unreadableOrgs.push(outcome.organisationId);
          break;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `  ${mode === 'dry-run' ? 'would-rotate' : 'rotated'}=${counts.rotated} alreadyActive=${counts.skippedAlreadyActive} ` +
        `concurrentChangeSkipped=${counts.skippedConcurrentChange} unreadable=${counts.skippedUnreadable}`,
    );
    if (unreadableOrgs.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`  UNREADABLE records found for organisation(s): ${unreadableOrgs.join(', ')} — investigate before relying on rotation completeness.`);
      process.exitCode = 1;
    }
    if (counts.skippedConcurrentChange > 0 && mode === 'apply') {
      // eslint-disable-next-line no-console
      console.log('  Some records changed concurrently and were skipped — safe to re-run this command to pick them up.');
    }
  }
}
