/**
 * OWNER-DB-ULTIMATE Part B3: one upgrade command of a release (Twenty `upgrade-version-command/<major-minor>/`,
 * `upgrade-command-registry.service.ts:209-215` names it `<version>_<Class>_<timestamp>`). Re-implemented, not copied.
 *
 * Rules every command must follow (B3 / C2):
 *   - IDEMPOTENT: a crash leaves no logbook row, so the next start runs the command again (test: run it twice);
 *   - tenant data only inside its tenant context (FORCE RLS stays on; the command binds the tenant itself);
 *   - it never touches core.upgrade_migration (the runner records the result).
 */
import type { Query } from '../upgrade-migration.service';

export interface UpgradeCommandContext {
  /** The locked migration session (autocommit; the command opens its own transactions). */
  query: Query;
  log: (line: string) => void;
}

export interface UpgradeCommand {
  /** Class-like name: [A-Za-z][A-Za-z0-9]*. */
  name: string;
  /** 13-digit creation timestamp: the order inside its release. */
  timestamp: number;
  run(ctx: UpgradeCommandContext): Promise<void>;
}
