/**
 * Final review F6: the dotenv files Nx loads into a task, so the production-authority checks read every one of them, not
 * only packages/rab-server/.env.
 *
 * Nx 22.7 (node_modules/nx/dist/src/tasks-runner/task-env.js getTaskSpecificEnv / loadDotEnvFilesForTask, and
 * task-env-paths.js getEnvPathsForTask) loads, for a task of project <root> and target <target>, in this order (first file
 * wins; a variable already in the environment is never overridden):
 *   <root>/.env.<target>.local  <root>/.env.<target>  <root>/.<target>.local.env  <root>/.<target>.env
 *   <root>/.env.local           <root>/.local.env     <root>/.env
 *   then the same seven names in the WORKSPACE root.
 * (bin/nx.js also loads the workspace root's .local.env, .env.local and .env at start — utils/dotenv.js loadRootEnvFiles —
 * and unloads them again before each task; they are in the list above.) With a configuration (`:<configuration>`) Nx also
 * loads `.env.<target>.<configuration>[.local]`, `.env.<configuration>[.local]` and their `.<x>.env` forms. rab-server and
 * rab-worker define no configurations, and Nx falls back to the (absent) default configuration for an unknown one
 * (create-task-graph.js resolveConfiguration), so those files are never loaded; nx-dotenv-files.spec.ts fails if a
 * configuration or a target is added without updating NX_PROJECT_TARGETS. Loading is on by default
 * (NX_LOAD_DOT_ENV_FILES !== 'false').
 *
 * Read as DATA only, never loaded into process.env here. Every file of every target of both projects counts (a process
 * cannot tell which Nx target started it, and an environment variable that narrowed the list would let the environment
 * decide what the check reads): a production command or runtime refuses production authority found in ANY of them.
 */
import * as fs from 'fs';
import * as path from 'path';

import { parse as parseDotenv } from 'dotenv';

/** Every target of the projects whose processes run these checks (packages/<project>/project.json). */
export const NX_PROJECT_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'packages/rab-server': [
    'start',
    'build',
    'lint',
    'test',
    'migration:run',
    'command',
    'migration:generate',
    'db:bind-identity',
    'deploy:prepare',
    'cache:flush',
  ],
  'packages/rab-worker': ['start', 'provision', 'build', 'lint', 'test'],
});

/** The repository root, from this file's location (src/ or dist/ of packages/rab-server: the same depth). */
export const WORKSPACE_ROOT = path.resolve(__dirname, '../../../../../..');

/** Nx's file names for one identifier (task-env-paths.js getEnvFileVariants). '' = the target-independent names. */
function variants(identifier: string): string[] {
  return identifier
    ? [`.env.${identifier}.local`, `.env.${identifier}`, `.${identifier}.local.env`, `.${identifier}.env`]
    : ['.env.local', '.local.env', '.env'];
}

/** The files Nx loads for one task, relative to the workspace root, in Nx's order (no configuration). Pure. */
export function nxDotenvFilesForTarget(projectRoot: string, target: string): string[] {
  const names = [...variants(target), ...variants('')];
  return [...names.map((name) => `${projectRoot}/${name}`), ...names];
}

/** The union over every target of NX_PROJECT_TARGETS, relative to the workspace root, first occurrence kept. Pure. */
export function nxDotenvFiles(): string[] {
  const files = new Set<string>();
  for (const [projectRoot, targets] of Object.entries(NX_PROJECT_TARGETS)) {
    for (const target of targets) for (const file of nxDotenvFilesForTarget(projectRoot, target)) files.add(file);
  }
  return [...files];
}

/**
 * Absolute paths of every Nx dotenv file under each candidate workspace root: this file's repository root and the
 * working directory (Nx runs the rab-server / rab-worker targets with cwd "."; a symlinked or bundled copy of this module
 * may sit elsewhere). Reading a candidate that is not a workspace root finds nothing — fail-closed, never narrower.
 */
export function nxDotenvPaths(roots: readonly string[] = [WORKSPACE_ROOT, process.cwd()]): string[] {
  const out = new Set<string>();
  for (const root of new Set(roots.map((r) => path.resolve(r)))) for (const file of nxDotenvFiles()) out.add(path.join(root, file));
  return [...out];
}

function readIfExists(file: string): string | null {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * The values of the given dotenv files, merged first-file-wins (Nx's own precedence), as data. A key present in ANY file
 * is present in the result. `read` is a test seam.
 */
export function readDotenvFilesValues(files: readonly string[], read: (file: string) => string | null = readIfExists): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of files) {
    const content = read(file);
    if (content === null) continue;
    for (const [key, value] of Object.entries(parseDotenv(content))) if (!(key in merged)) merged[key] = value;
  }
  return merged;
}

/** Every Nx dotenv file's values (nxDotenvPaths), as data. */
export function readNxDotenvValues(roots?: readonly string[], read?: (file: string) => string | null): Record<string, string> {
  return readDotenvFilesValues(nxDotenvPaths(roots), read);
}
