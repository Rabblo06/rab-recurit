import * as fs from 'fs';
import * as path from 'path';

import { stripComments } from '../helpers/strip-comments';

/**
 * The two exported pieces of TenantContextService's binder (engine/core-modules/tenant/tenant-context.service.ts) are pinned
 * to their reviewed callers (security review of #241):
 *
 * 1. `bindGucsSql` is the binding statement itself: it writes `rab.actor_type` from parameter $5. Any file could otherwise
 *    run `manager.query(bindGucsSql(), [..., 'worker'])` and pass every other spec (no raw set_config, no `actorType`
 *    literal). It has NO allowed external caller: only tenant-context.service.ts itself may name it (tests excepted).
 *
 * 2. `bindMaintenanceSessionGucs` binds the tenant identity GUCs, `rab.actor_type` included, WITHOUT the pool-safety layer of
 *    TenantContextService's own binder: no RESET ROLE and no current_user = session_user check. That is right for the two
 *    maintenance sessions it exists for (the Worker's orphan connection acts as crewflow through a session-level SET ROLE
 *    that RESET ROLE would drop), and wrong anywhere else: a request path calling it would skip the RESET ROLE without
 *    needing any `actorType: 'worker'` literal.
 *
 * In the non-test sources of rab-server and rab-worker, a file that names a pinned function in code (comments stripped with
 * the TypeScript parser) and is not on its list fails, and so does a listed file that stops naming it (no stale entries).
 * Any new caller needs a reviewed entry with its reason.
 *
 * Known limits (a tripwire, not a proof; covered by review, listed in THREAT-MODEL.md): access by a computed name
 * (`mod['bind' + x]`); a wrapper exported from an allow-listed file (`export const g = bindMaintenanceSessionGucs`, or a
 * function that calls it) and then called elsewhere under its own name; a re-export under another name beyond its first
 * hop (worker-shared-reexports.spec.ts fences the Worker surface). A namespace import used as `ns.<name>` is caught: the
 * name appears.
 */
const SERVER_SRC = path.resolve(__dirname, '../..');
const WORKER_SRC = path.resolve(__dirname, '../../../../rab-worker/src');
const DEFINITION = 'rab-server/engine/core-modules/tenant/tenant-context.service.ts';

const MAINTENANCE_CALLERS: Record<string, string> = {
  'rab-server/database/typeorm/workspace-schema/workspace-core-orphans.ts':
    'the Worker orphan check: BEGIN READ ONLY on its own connection, which acts as crewflow through a session-level SET ROLE',
  'rab-server/engine/worker-shared/maintenance-session-binder.ts':
    "the Worker's import surface (a re-export only; worker-shared-reexports.spec.ts lists it)",
  'rab-worker/queues/rab-maintenance/account-invite-cleanup.job.ts':
    "the account-invite cleanup's level-22 pass: a mid-transaction overlay inside a candidate savepoint, bound back after",
};

/** Per pinned export: the files (other than its definition) allowed to name it in code, each with its reason. */
const PINNED: Record<string, Record<string, string>> = {
  bindGucsSql: {},
  bindMaintenanceSessionGucs: MAINTENANCE_CALLERS,
};

const nameOf = (fn: string) => new RegExp(String.raw`\b${fn}\b`);

function sources(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts') && !d.name.endsWith('.spec.ts'))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !/[\\/]__tests__[\\/]/.test(f));
}

const codeCache = new Map<string, string>();
const code = (f: string) => {
  let text = codeCache.get(f);
  if (text === undefined) codeCache.set(f, (text = stripComments(fs.readFileSync(f, 'utf8'), f)));
  return text;
};

function callers(re: RegExp): string[] {
  const found: string[] = [];
  for (const [pkg, root] of [
    ['rab-server', SERVER_SRC],
    ['rab-worker', WORKER_SRC],
  ] as const) {
    for (const f of sources(root)) {
      const rel = `${pkg}/${path.relative(root, f).replace(/\\/g, '/')}`;
      if (rel === DEFINITION) continue;
      if (re.test(code(f))) found.push(rel);
    }
  }
  return found.sort();
}

describe('the tenant binder exports have exactly the reviewed callers (static)', () => {
  it('scans the real sources and finds both definitions', () => {
    const text = code(path.join(SERVER_SRC, 'engine/core-modules/tenant/tenant-context.service.ts'));
    expect(text).toMatch(/export async function bindMaintenanceSessionGucs\(/);
    expect(text).toMatch(/export function bindGucsSql\(/);
    expect(sources(SERVER_SRC).length).toBeGreaterThan(200);
    expect(sources(WORKER_SRC).length).toBeGreaterThan(50);
  });

  it.each(Object.keys(PINNED))('%s: the callers are exactly the allow-list (no new caller, no stale entry)', (fn) => {
    expect(callers(nameOf(fn))).toEqual(Object.keys(PINNED[fn]!).sort());
  });

  it('bindGucsSql has no external caller at all: running the binding statement by hand anywhere else fails', () => {
    expect(PINNED.bindGucsSql).toEqual({});
    expect(nameOf('bindGucsSql').test(stripComments("await manager.query(bindGucsSql(), [org, ws, '', '', 'worker']);"))).toBe(true);
  });

  it('a name inside a comment does not count, a call, an aliased import or a namespace access does', () => {
    const re = nameOf('bindMaintenanceSessionGucs');
    expect(re.test(stripComments('// see bindMaintenanceSessionGucs\nconst x = 1;'))).toBe(false);
    expect(re.test(stripComments("import { bindMaintenanceSessionGucs as b } from './x';"))).toBe(true);
    expect(re.test(stripComments('await ns.bindMaintenanceSessionGucs(q, ctx);'))).toBe(true);
    expect(nameOf('bindGucsSql').test('bindGucsSqlText')).toBe(false);
  });

  it('every entry carries a reason', () => {
    for (const list of Object.values(PINNED)) for (const why of Object.values(list)) expect(why.length).toBeGreaterThan(20);
  });
});
