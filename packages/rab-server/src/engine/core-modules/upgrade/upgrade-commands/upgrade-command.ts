/**
 * OWNER-DB-ULTIMATE Part B3: one upgrade command of a release (Twenty `upgrade-version-command/<major-minor>/`,
 * `upgrade-command-registry.service.ts:209-215` names it `<version>_<Class>_<timestamp>`). Re-implemented, not copied.
 *
 * Rules every command must follow (B3 / C2):
 *   - IDEMPOTENT, and safe to run again after it FAILED part-way: a crash leaves no logbook row, so the next start runs the
 *     command again; a failed attempt is retried by the next start of the same release AND by its patch releases, under this
 *     release's step name (owner decision 2026-11-18, upgrade-runner.ts). It keeps its progress in the database and re-checks
 *     it (test: run it twice, and once more after a failure). Audit 2026-11-18: 0.6.0 has no instance command; 0.7.0's
 *     HwsCutover (not registered yet) is resumable by design (state table started → verified, ON CONFLICT DO NOTHING copies,
 *     already-verified workspaces skipped, the activation sentinel inserted ON CONFLICT DO NOTHING; hws-c3-cutover spec);
 *   - tenant data only inside its tenant context (FORCE RLS stays on; the command binds the tenant itself);
 *   - it never touches core.upgrade_migration (the runner records the result).
 */
import type { Query } from '../upgrade-migration.service';

/**
 * Part C3: what the runner lends a command beyond the database session. Command files import no fs / env / crypto
 * themselves (source guard, workspace-command-runner.spec.ts), so the few host facts a command needs come through here
 * (upgrade-command-host.ts builds the real one; specs pass fakes).
 */
export interface UpgradeCommandHost {
  /** A read-only snapshot of the process environment (never logged). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** HWS_RUNTIME_ENABLED as the environment class resolves it (hws-runtime-default.ts); an invalid value counts as off. */
  readonly hwsRuntimeEnabled: boolean;
  /** Whether `path` is absolute on this host. */
  isAbsolutePath(path: string): boolean;
  /** `fileName` in the directory of `path`. */
  siblingPath(path: string, fileName: string): string;
  /** The text of a regular file (not a symlink) of at most maxBytes; null when absent, not a regular file, or larger. */
  readSmallFile(path: string, maxBytes: number): Promise<string | null>;
  /** sha256 (hex), size and the first 8 bytes (latin1) of a regular file (not a symlink); null when absent / not regular. */
  fileDigest(path: string): Promise<{ sha256: string; size: number; head: string } | null>;
}

export interface UpgradeCommandContext {
  /** The locked migration session (autocommit; the command opens its own transactions). */
  query: Query;
  log: (line: string) => void;
  /** Part C3: host facts (absent in older call sites; a command that needs it refuses without it). */
  host?: UpgradeCommandHost;
  /**
   * Part C3: the command wrote, kept or lifted a Part D block marker (core.workspace_schema_registry.migration_error), so
   * the resolver cache epoch must be bumped after this run (migrate-on-start, review P2), even when the command failed.
   */
  markBlockChanged?: () => void;
  /**
   * Part C3 (security review L-4): bump the resolver cache epoch NOW (a cached READY resolution must not route a workspace
   * the command just blocked). Throws when it cannot (Redis configured but unreachable): the command must then stop before
   * it copies anything. Absent = no cache to bump (no Redis, or a test).
   */
  flushBlockCache?: () => Promise<void>;
}

export interface UpgradeCommand {
  /** Class-like name: [A-Za-z][A-Za-z0-9]*. */
  name: string;
  /** 13-digit creation timestamp: the order inside its release. */
  timestamp: number;
  run(ctx: UpgradeCommandContext): Promise<void>;
}
