/**
 * OWNER-DB-ULTIMATE Part D: one WORKSPACE upgrade command of a release, run once per workspace schema by the workspace
 * command runner (workspace-command-runner.ts) and recorded per workspace in core.upgrade_migration. Twenty
 * (twentyhq/twenty @ eedb0a73): the workspace commands of `upgrade-version-command/<major-minor>/`, registered with a name
 * `<version>_<Class>_<timestamp>` (`engine/core-modules/upgrade/services/upgrade-command-registry.service.ts:135-158`) and
 * run by `workspace-command-runner.service.ts:106-153` (`runOnWorkspace`). Re-implemented, not copied.
 *
 * It replaces a Crewflow "workspace module" (workspace-schema-modules.ts, frozen at 20): new workspace DDL ships here, never
 * as a 21st module. Rules every workspace command must follow (D-RUNNER.md §4 / §5.3):
 *   - IDEMPOTENT: a crash leaves no logbook row (or the row is lost after COMMIT), so the command runs again;
 *   - it touches ONLY its own workspace schema (`ctx.schemaName`): the runner refuses SQL naming another workspace schema,
 *     binds the tenant to this workspace (FORCE RLS), and rolls back any catalog change outside the schema;
 *   - it never ends, commits or re-binds the transaction, never changes the role or search_path (checked after it runs);
 *   - a STRUCTURAL command (DDL) declares `structure`: its level (previous + 1, from 21) and the expected fingerprint per
 *     PostgreSQL major. The same SQL must also be folded into core.provision_workspace (a core migration; owner SQL review),
 *     so new workspaces are built at the same structure. A command without `structure` must not change the structure: the
 *     post-step check compares against the workspace's current level.
 *   - it never touches core.upgrade_migration (the runner records the result).
 */
import type { Query } from '../upgrade-migration.service';

export interface WorkspaceUpgradeCommandContext {
  /** The validated, derived schema `workspace_<32 hex>` of this workspace. */
  readonly schemaName: string;
  readonly workspaceId: string;
  readonly organisationId: string;
  /** Guarded query inside the runner's per-(workspace, command) transaction (tenant bound, search_path pg_catalog). */
  readonly query: Query;
  readonly log: (line: string) => void;
}

export interface WorkspaceStructureDeclaration {
  /** The structure level after this command (`core.workspace_schema_registry.module_version`): previous level + 1, ≥ 21. */
  readonly level: number;
  /** Expected `core.workspace_schema_fingerprint` after this command, per PostgreSQL major (16, 17, 18). */
  readonly fingerprints: Readonly<Partial<Record<16 | 17 | 18, string>>>;
}

export interface WorkspaceUpgradeCommand {
  readonly kind: 'workspace';
  /** Class-like name: [A-Za-z][A-Za-z0-9]*. */
  readonly name: string;
  /** 13-digit creation timestamp: the order inside its release (after the release's instance commands). */
  readonly timestamp: number;
  /** DDL for one schema (the name is validated and safe to inline). Either `sql` or `run`. */
  readonly sql?: (schemaName: string) => string;
  /** Data pre-check: a query returning one row `{ n }`; n > 0 refuses (nothing applied). */
  readonly precheck?: (schemaName: string) => string;
  /** Free-form body for data commands (bounded to its workspace by the runner's checks). */
  readonly run?: (ctx: WorkspaceUpgradeCommandContext) => Promise<void>;
  /** Present only for a command that changes the workspace structure. */
  readonly structure?: WorkspaceStructureDeclaration;
}
