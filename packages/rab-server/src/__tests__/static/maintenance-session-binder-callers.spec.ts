import * as fs from 'fs';
import * as path from 'path';

import { stripComments } from '../helpers/strip-comments';

/**
 * `bindMaintenanceSessionGucs` (engine/core-modules/tenant/tenant-context.service.ts) binds the tenant identity GUCs,
 * `rab.actor_type` included, WITHOUT the pool-safety layer of TenantContextService's own binder: no RESET ROLE and no
 * current_user = session_user check. That is right for the two maintenance sessions it exists for (the Worker's orphan
 * connection acts as crewflow through a session-level SET ROLE that RESET ROLE would drop), and wrong anywhere else: a request
 * path calling it would skip the RESET ROLE without needing any `actorType: 'worker'` literal (security review of #241).
 *
 * So its callers are pinned here, exactly, in the non-test sources of rab-server and rab-worker: a file that names the
 * function in code (comments stripped with the TypeScript parser) and is not on this list fails, and so does a listed file
 * that stops naming it (no stale entries). Any new caller needs a reviewed entry with its reason.
 *
 * Blind spots (a tripwire, not a proof): access by a computed name (`mod['bind' + x]`), and a re-export under another name
 * beyond its first hop (worker-shared-reexports.spec.ts fences the Worker surface). A namespace import used as
 * `ns.bindMaintenanceSessionGucs` is caught: the name appears.
 */
const SERVER_SRC = path.resolve(__dirname, '../..');
const WORKER_SRC = path.resolve(__dirname, '../../../../rab-worker/src');
const DEFINITION = 'rab-server/engine/core-modules/tenant/tenant-context.service.ts';

const ALLOWED_CALLERS: Record<string, string> = {
  'rab-server/database/typeorm/workspace-schema/workspace-core-orphans.ts':
    'the Worker orphan check: BEGIN READ ONLY on its own connection, which acts as crewflow through a session-level SET ROLE',
  'rab-server/engine/worker-shared/maintenance-session-binder.ts':
    "the Worker's import surface (a re-export only; worker-shared-reexports.spec.ts lists it)",
  'rab-worker/queues/rab-maintenance/account-invite-cleanup.job.ts':
    "the account-invite cleanup's level-22 pass: a mid-transaction overlay inside a candidate savepoint, bound back after",
};

function sources(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts') && !d.name.endsWith('.spec.ts'))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !/[\\/]__tests__[\\/]/.test(f));
}

const NAME = /\bbindMaintenanceSessionGucs\b/;

function callers(): string[] {
  const found: string[] = [];
  for (const [pkg, root] of [
    ['rab-server', SERVER_SRC],
    ['rab-worker', WORKER_SRC],
  ] as const) {
    for (const f of sources(root)) {
      const rel = `${pkg}/${path.relative(root, f).replace(/\\/g, '/')}`;
      if (rel === DEFINITION) continue;
      if (NAME.test(stripComments(fs.readFileSync(f, 'utf8'), f))) found.push(rel);
    }
  }
  return found.sort();
}

describe('bindMaintenanceSessionGucs (no RESET ROLE) has exactly the reviewed callers (static)', () => {
  it('scans the real sources and finds the definition', () => {
    const def = path.join(SERVER_SRC, 'engine/core-modules/tenant/tenant-context.service.ts');
    expect(stripComments(fs.readFileSync(def, 'utf8'))).toMatch(/export async function bindMaintenanceSessionGucs\(/);
    expect(sources(SERVER_SRC).length).toBeGreaterThan(200);
    expect(sources(WORKER_SRC).length).toBeGreaterThan(50);
  });

  it('the callers are exactly the allow-list (no new caller, no stale entry)', () => {
    expect(callers()).toEqual(Object.keys(ALLOWED_CALLERS).sort());
  });

  it('a name inside a comment does not count, a call does', () => {
    expect(NAME.test(stripComments('// see bindMaintenanceSessionGucs\nconst x = 1;'))).toBe(false);
    expect(NAME.test(stripComments("import { bindMaintenanceSessionGucs as b } from './x';"))).toBe(true);
    expect(NAME.test(stripComments('await ns.bindMaintenanceSessionGucs(q, ctx);'))).toBe(true);
  });

  it('every entry carries a reason', () => {
    for (const why of Object.values(ALLOWED_CALLERS)) expect(why.length).toBeGreaterThan(20);
  });
});
