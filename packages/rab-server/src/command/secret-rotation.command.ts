import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Command, CommandRunner, Option } from 'nest-commander';

import { AccessTokenService } from '../engine/core-modules/auth/token/services/access-token.service';
import { SecretEncryptionService } from '../engine/core-modules/secret-encryption/secret-encryption.service';
import {
  ENCRYPTED_COLUMN_TARGETS,
  EncryptedColumnTarget,
  RotationCheckpoint,
  RotationCheckpointStore,
  SecretRotationService,
} from '../engine/core-modules/secret-encryption/secret-rotation.service';

interface Options {
  dryRun?: boolean;
  apply?: boolean;
  verify?: boolean;
  checkKeyring?: boolean;
  target?: EncryptedColumnTarget[];
  batchSize?: number;
  checkpointFile?: string;
  maxRotations?: number;
  retireKid?: string;
}

/**
 * Checkpoint file: ids, kid labels and timestamps only (never ciphertext, plaintext or keys). Written atomically
 * (temp file + rename) so an interruption mid-write leaves the previous checkpoint intact.
 */
export class FileRotationCheckpointStore implements RotationCheckpointStore {
  constructor(private readonly file: string) {}

  async load(): Promise<RotationCheckpoint | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as RotationCheckpoint;
      return parsed && parsed.v === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(checkpoint: RotationCheckpoint): Promise<void> {
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(checkpoint, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

/**
 * `secret:rotate` — rotation tooling for SecretEncryptionService's versioned keyring (`APP_ENCRYPTION_KEYRING` /
 * `APP_ENCRYPTION_ACTIVE_KID`). Wave 5 lane OPS: every encrypted column (`--target smtp_password,push_token,totp_secret`,
 * default all), bounded batches, resumable from a checkpoint file, and a kid-retirement gate.
 *
 * Never prints plaintext, keys, raw ciphertext, SMTP credentials, push tokens, TOTP secrets or a database URL — every line
 * is built from target names, organisation/row ids, kid labels and counts.
 *
 * Modes (mutually exclusive; `--dry-run` is the default — report-only, zero writes):
 *   --dry-run       classify every row and report what --apply WOULD rewrite; zero writes
 *   --apply         re-encrypt every readable row that is not a RAB2 envelope on the active kid (compare-and-set per row;
 *                   idempotent). Progress is checkpointed (`--checkpoint-file`, default
 *                   `./.crewflow/secret-rotation.checkpoint.json`); after an interruption (Ctrl-C, SIGTERM, a crash) the
 *                   same command resumes. `--max-rotations N` stops cleanly after N writes (staged rollout).
 *   --verify        report per target / per kid; exit 1 unless EVERY row decrypts and sits on the active kid.
 *                   `--verify --retire-kid <kid>`: exit 0 ONLY when it is safe to remove <kid> from the keyring
 *                   (not active, present, no row uses it, nothing unreadable, nothing pending, write path present).
 *                   This is the only supported gate before deleting a kid from APP_ENCRYPTION_KEYRING.
 *   --check-keyring prints THIS process's resolved kids for SecretEncryptionService and AccessTokenService (never key
 *                   material) — run on every instance before flipping an active kid (multi-instance runbook).
 *
 * `DB_TARGET` and the production-command safeguards run globally in `command/main.ts`'s `bootstrap()` before `run()`.
 * Runs as the ordinary runtime identity: every row is reached through `TenantContextService` per organisation (RLS on),
 * the TOTP column only through DB5's `core.mfa_totp_state` / `core.mfa_rotate_totp_secret` functions.
 */
@Command({
  name: 'secret:rotate',
  description: 'Inspect, rotate or verify SecretEncryptionService-encrypted columns against the active keyring entry (dry-run by default)',
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

  @Option({ flags: '--apply', description: 'MODIFIES: re-encrypt every needs-rotation record under the active key (resumable)' })
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

  @Option({ flags: '--target <targets>', description: `Comma-separated subset of: ${ENCRYPTED_COLUMN_TARGETS.join(', ')} (default: all)` })
  parseTarget(value: string): EncryptedColumnTarget[] {
    const names = value.split(',').map((v) => v.trim()).filter(Boolean);
    const unknown = names.filter((n) => !(ENCRYPTED_COLUMN_TARGETS as readonly string[]).includes(n));
    if (names.length === 0 || unknown.length > 0) throw new Error(`--target: unknown target(s) ${unknown.join(', ') || '(none given)'}; valid: ${ENCRYPTED_COLUMN_TARGETS.join(', ')}`);
    return names as EncryptedColumnTarget[];
  }

  @Option({ flags: '--batch-size <n>', description: 'Rows per transaction, 1..1000 (default 200)' })
  parseBatchSize(value: string): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('--batch-size must be an integer 1..1000');
    return n;
  }

  @Option({ flags: '--checkpoint-file <path>', description: 'Resume checkpoint for --apply (default ./.crewflow/secret-rotation.checkpoint.json)' })
  parseCheckpointFile(value: string): string {
    return value;
  }

  @Option({ flags: '--max-rotations <n>', description: '--apply: stop cleanly after N rows were rewritten (checkpoint saved)' })
  parseMaxRotations(value: string): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error('--max-rotations must be a positive integer');
    return n;
  }

  @Option({ flags: '--retire-kid <kid>', description: '--verify: exit 0 only if <kid> can be safely removed from APP_ENCRYPTION_KEYRING' })
  parseRetireKid(value: string): string {
    return value;
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
    if (options.retireKid !== undefined && mode !== 'verify') throw new Error('--retire-kid is only valid with --verify.');
    if (options.maxRotations !== undefined && mode !== 'apply') throw new Error('--max-rotations is only valid with --apply.');

    // eslint-disable-next-line no-console
    console.log(`[secret:rotate] mode=${mode} activeKid=${this.secretEncryption.currentActiveKid}`);

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
      const report = await this.rotation.verify({ targets: options.target, retireKid: options.retireKid });
      for (const t of report.targets) {
        const kids = Object.entries(t.byKid).map(([k, n]) => `${k}:${n}`).join(' ') || '-';
        // eslint-disable-next-line no-console
        console.log(
          `  ${t.target.padEnd(14)} installed=${t.installed} writable=${t.writable} total=${t.total} active=${t.active} ` +
            `needsRotation=${t.needsRotation} unreadable=${t.unreadable} legacyEnvelope=${t.legacyEnvelope} byKid=[${kids}]`,
        );
      }
      for (const row of report.unreadableRows) {
        // eslint-disable-next-line no-console
        console.error(`  UNREADABLE ${row.target} organisation=${row.organisationId} row=${row.rowId} (unknown kid, corrupt or tampered)`);
      }
      let ok = report.allOnActiveKid;
      if (report.retireKid) {
        ok = report.retireKid.safe;
        // eslint-disable-next-line no-console
        console.log(report.retireKid.safe ? `  SAFE to retire kid "${report.retireKid.kid}".` : `  NOT SAFE to retire kid "${report.retireKid.kid}":`);
        for (const reason of report.retireKid.reasons) {
          // eslint-disable-next-line no-console
          console.error(`    - ${reason}`);
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(ok ? '  Every row decrypts and is on the active kid.' : '  NOT complete: rows remain that are unreadable or not on the active kid.');
      }
      if (!ok) process.exitCode = 1;
      return;
    }

    const checkpointFile = options.checkpointFile ?? path.resolve(process.cwd(), '.crewflow', 'secret-rotation.checkpoint.json');
    const checkpoint = mode === 'apply' ? new FileRotationCheckpointStore(checkpointFile) : undefined;
    if (checkpoint) {
      const existing = await checkpoint.load();
      if (existing?.position) {
        // eslint-disable-next-line no-console
        console.log(
          existing.activeKid === this.secretEncryption.currentActiveKid
            ? `  resuming from checkpoint: target=${existing.position.target} organisation>=${existing.position.organisationId}`
            : `  ignoring checkpoint written for activeKid=${existing.activeKid} (different rotation)`,
        );
      }
    }
    const abort = new AbortController();
    const onSignal = () => {
      // eslint-disable-next-line no-console
      console.error('  interrupt received — finishing the current batch and saving the checkpoint');
      abort.abort();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const counts: Record<string, Record<string, number>> = {};
    let unreadable = 0;
    try {
      for await (const outcome of this.rotation.rotateAll({
        dryRun: mode === 'dry-run',
        targets: options.target,
        batchSize: options.batchSize,
        checkpoint,
        maxRotations: options.maxRotations,
        signal: abort.signal,
      })) {
        counts[outcome.target] ??= {};
        counts[outcome.target]![outcome.action] = (counts[outcome.target]![outcome.action] ?? 0) + 1;
        if (outcome.action === 'skipped-unreadable') {
          unreadable += 1;
          // eslint-disable-next-line no-console
          console.error(`  UNREADABLE ${outcome.target} organisation=${outcome.organisationId} row=${outcome.rowId}`);
        }
      }
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    for (const [target, byAction] of Object.entries(counts)) {
      // eslint-disable-next-line no-console
      console.log(`  ${target.padEnd(14)} ${Object.entries(byAction).map(([a, n]) => `${a}=${n}`).join(' ')}`);
    }
    if (abort.signal.aborted) {
      // eslint-disable-next-line no-console
      console.log(`  interrupted — re-run the same command to resume (checkpoint: ${checkpointFile})`);
      process.exitCode = 130;
    }
    if (unreadable > 0) process.exitCode = 1;
    if (mode === 'apply') {
      // eslint-disable-next-line no-console
      console.log('  next: secret:rotate --verify (then --verify --retire-kid <old> before removing any kid)');
    }
  }
}
