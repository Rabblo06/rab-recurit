/**
 * OWNER-DB-ULTIMATE Part D (security review M3): the code's workspace STRUCTURE LEVEL. Levels 1..20 are the frozen
 * workspace-module template (workspace-schema-modules.ts); every structural workspace upgrade command of this code's registry
 * adds one level (21, 22, …, strictly in release / timestamp order). Every gate that used to compare against
 * LATEST_WORKSPACE_MODULE_VERSION (schema-compatibility, deploy post-checks, the resolver's "ahead" warning, the TypeScript
 * provisioner and its recorder) compares against this instead, so the first structural command does not make the fleet
 * refuse to start. Pure: no database, no Nest.
 */
import type { WorkspaceStructureDeclaration, WorkspaceUpgradeCommand } from './upgrade-commands/workspace-upgrade-command';
import { WORKSPACE_UPGRADE_COMMANDS } from './upgrade-commands/registry';
import { compareVersions } from './upgrade-version';
import { LATEST_WORKSPACE_MODULE_VERSION } from '../../../database/typeorm/workspace-schema/workspace-schema-modules';

export type WorkspaceRegistryInput = Readonly<Record<string, readonly WorkspaceUpgradeCommand[]>>;

export interface StructuralCommand {
  key: string;
  command: WorkspaceUpgradeCommand;
  structure: WorkspaceStructureDeclaration;
}

const keyVersion = (key: string) => {
  const m = /^(\d+)-(\d+)$/.exec(key);
  if (!m) throw new Error(`workspace upgrade registry key ${JSON.stringify(key)} is not <major>-<minor>`);
  return `${m[1]}.${m[2]}.0`;
};

/** Every structural command of the registry in release then timestamp order; levels validated (21, 22, … with no gap). */
export function structuralCommands(registry: WorkspaceRegistryInput = WORKSPACE_UPGRADE_COMMANDS): StructuralCommand[] {
  const keys = Object.keys(registry).sort((a, b) => compareVersions(keyVersion(a), keyVersion(b)));
  const out: StructuralCommand[] = [];
  let level = LATEST_WORKSPACE_MODULE_VERSION;
  for (const key of keys) {
    for (const command of [...registry[key]!].sort((a, b) => a.timestamp - b.timestamp)) {
      if (!command.structure) continue;
      if (command.structure.level !== level + 1) {
        throw new Error(`workspace command ${key}/${command.name}: structure level ${command.structure.level}, expected ${level + 1}`);
      }
      level = command.structure.level;
      out.push({ key, command, structure: command.structure });
    }
  }
  return out;
}

/** The code's structure level: 20 + the structural commands this code knows. */
export function codeWorkspaceStructureLevel(registry: WorkspaceRegistryInput = WORKSPACE_UPGRADE_COMMANDS): number {
  const all = structuralCommands(registry);
  return all.length ? all[all.length - 1]!.structure.level : LATEST_WORKSPACE_MODULE_VERSION;
}

/** The structural commands that build levels 21..level (the TypeScript provisioner applies them after the 20 modules). */
export function structuralCommandsThrough(level: number, registry: WorkspaceRegistryInput = WORKSPACE_UPGRADE_COMMANDS): StructuralCommand[] {
  return structuralCommands(registry).filter((s) => s.structure.level <= level);
}

/** The expected fingerprint of a level above 20 on a PostgreSQL major (undefined when not declared). */
export function declaredFingerprint(level: number, major: 16 | 17 | 18, registry: WorkspaceRegistryInput = WORKSPACE_UPGRADE_COMMANDS): string | undefined {
  return structuralCommands(registry).find((s) => s.structure.level === level)?.structure.fingerprints[major];
}

/**
 * The `core.provision_workspace` literals of the structural commands (each structural release re-creates the function in an
 * owner-reviewed core migration and names its literal on the command), merged into the frozen provision-function map.
 */
export function declaredProvisionLiterals(registry: WorkspaceRegistryInput = WORKSPACE_UPGRADE_COMMANDS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of structuralCommands(registry)) if (s.structure.provisionFunctionLiteral) out[s.structure.provisionFunctionLiteral] = s.structure.level;
  return out;
}
