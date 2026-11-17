import * as fs from 'fs';
import * as path from 'path';

import { stripComments } from '../helpers/strip-comments';

/**
 * `rab.actor_type = 'worker'` is an RLS marker: the `*_worker_scan` / `*_worker_select` / `*_worker_update` policies
 * (staff_profile, payroll_record, payroll_run, payroll_run_line, shift_staff_review, ...) open a wider read/write path to
 * any session that carries it. It must therefore be set ONLY by trusted server code for a system execution context with
 * no human actor, never from a JWT, a request body, a queue payload or Redis (auth-context.interface.ts, `actorType`).
 *
 * A static scan of the non-test sources of rab-server AND rab-worker (there is no ESLint here; "lint" = tsc), modelled
 * on the T6-P3 spec (ai-agents-no-execution.spec.ts). Per package, it fails when:
 *   1. any assignment to `actorType` — `actorType:` / `actorType?:` / `'actorType':` / `actorType =` / `??=` / `||=` /
 *      `&&=`, WHATEVER the value — appears in a file that is not on that package's allowlist, or an allowlisted file
 *      gains or loses a site (exact counts, so the list can neither grow silently nor go stale). Every allowed site
 *      today is the literal `'worker'`, which is asserted separately;
 *   2. the GUC is written directly — `set_config('rab.actor_type', ...)` (any schema prefix, either quote) or
 *      `SET [LOCAL|SESSION] rab.actor_type` / `"rab.actor_type"` — anywhere but TenantContextService, apart from the
 *      listed maintenance-tool sites that predate this spec.
 * Comments are stripped first with the TypeScript scanner (strings, templates and regexes are kept as code): several
 * files explain the rule by naming the forbidden form.
 *
 * This is a tripwire, not a proof: a GUC name passed as a bound parameter, or an object built by computed key, is not
 * seen. Review still applies; this catches the plain copy-paste case.
 */
const SERVER_SRC = path.resolve(__dirname, '../..');
const WORKER_SRC = path.resolve(__dirname, '../../../../rab-worker/src');

function sources(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts') && !d.name.endsWith('.spec.ts'))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !/[\\/]__tests__[\\/]/.test(f));
}
const count = (text: string, re: RegExp) => (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;

/** Any assignment to `actorType`, whatever the value (`===` / `!==` comparisons and `??` reads are not assignments). */
const ACTOR_TYPE_ASSIGNMENT = /['"]?\bactorType['"]?\s*(?:\??\s*:|=(?!=)|\?\?=|\|\|=|&&=)/g;
/** The same, with the literal value `'worker'`. */
const ACTOR_TYPE_WORKER = /['"]?\bactorType['"]?\s*(?:\??\s*:|=(?!=)|\?\?=|\|\|=|&&=)\s*['"`]worker['"`]/g;
/** `set_config('rab.actor_type'` with any prefix (`pg_catalog.`) and either quote; `SET [LOCAL|SESSION] ["]rab.actor_type`. */
const RAW_ACTOR_TYPE_GUC = /set_config\s*\(\s*['"]rab\.actor_type['"]|\bSET\s+(?:LOCAL\s+|SESSION\s+)?"?rab\.actor_type\b/gi;

type Allowlist = Record<string, { sites: number; why: string }>;

/** rab-server files allowed to assign `actorType`, with their exact number of sites and why. */
const SERVER_ACTOR_TYPE_ALLOWLIST: Allowlist = {
  'engine/core-modules/tenant/auth-context.interface.ts': {
    sites: 1,
    why: "the declaration itself (`actorType?: 'worker'`): the only value the field can hold; sets nothing",
  },
  'modules/ai/services/ai-retention.service.ts': {
    sites: 2,
    why:
      'AI conversation/usage retention: invoked only by the Worker job (rab-worker ai.processors.ts), one organisation at ' +
      'a time with no human actor; the purge itself runs through the SECURITY DEFINER core.ai_purge_expired_conversations',
  },
  'engine/core-modules/secret-encryption/secret-rotation.service.ts': {
    sites: 2,
    why:
      'secret key rotation (secret-rotation.command.ts and the Worker): a local copy of rab-worker runScopedForOrg ' +
      '(rab-server cannot import the Worker) plus a catalogue-only probe context; organisations come from ' +
      'core.worker_list_organisations, never from a request',
  },
};

/** rab-worker files allowed to assign `actorType`: the Worker's system scan contexts, each bound per discovered scope. */
const WORKER_ACTOR_TYPE_ALLOWLIST: Allowlist = {
  'core/database/scoped-job.ts': {
    sites: 1,
    why: 'runScopedForOrg: THE Worker helper for one (organisation, workspace) taken from a committed row or discovery',
  },
  'core/database/workspace-discovery.ts': {
    sites: 2,
    why: 'discoverInWorkspaces: one scan per READY workspace listed by the SECURITY DEFINER core.worker_list_workspaces()',
  },
  'queues/rab-reports/final-timesheet.job.ts': {
    sites: 3,
    why: 'final timesheet cycle: candidates from the worker discovery scan; no human actor behind the job',
  },
  'queues/rab-reports/shift-report-scheduler.job.ts': {
    sites: 2,
    why: 'shift report scheduler: candidates from the worker discovery scan; no human actor behind the job',
  },
  'queues/rab-reports/payroll-period-attention.job.ts': {
    sites: 1,
    why: 'payroll period attention notices: candidates from the worker discovery scan; no human actor behind the job',
  },
  'queues/rab-reports/shift-statement.job.ts': {
    sites: 1,
    why: 'pay statement generation (`workerCtx`): scope from the claimed payroll row / discovery, never from the payload alone',
  },
};

/** The single binding point every runtime context goes through (`bindGucsSql`, $5 = ctx.actorType). */
const TENANT_CONTEXT_SERVICE = 'engine/core-modules/tenant/tenant-context.service.ts';

/**
 * Raw writes of the GUC outside TenantContextService that predate this spec. All are maintenance tools on their own
 * connection or savepoint (not the request path) and documented in place. Listed so a NEW raw site fails; whether they
 * should move behind TenantContextService is an owner decision, not made here.
 */
const SERVER_RAW_GUC_ALLOWLIST: Allowlist = {
  'database/typeorm/workspace-schema/backfill/hws-backfill.service.ts': {
    sites: 1,
    why: 'HWS backfill ops command, read identity on the crewflow connection (bindReadIdentity; see the class doc comment)',
  },
  'database/typeorm/workspace-schema/workspace-core-orphans.ts': {
    sites: 1,
    why: 'workspace -> core orphan check on a raw pg Client, BEGIN READ ONLY, counts only (SECURITY TRADE-OFF 0a-T2)',
  },
};
const WORKER_RAW_GUC_ALLOWLIST: Allowlist = {
  'queues/rab-maintenance/account-invite-cleanup.job.ts': {
    sites: 2,
    why:
      'level-22 cleanup (withLevel22Visibility): sets worker + the workspace owner, then restores the previous values ' +
      '(the second site); same binding as the orphan check, owner decision 0a-T2',
  },
};

interface Scanned {
  files: string[];
  rel: (f: string) => string;
}
const scan = (root: string): Scanned => ({ files: sources(root), rel: (f) => path.relative(root, f).replace(/\\/g, '/') });
const SERVER = scan(SERVER_SRC);
const WORKER = scan(WORKER_SRC);
const codeCache = new Map<string, string>();
/** Code only: comments may (and do) explain the rule by naming what is forbidden. */
const code = (f: string): string => {
  const cached = codeCache.get(f);
  if (cached !== undefined) return cached;
  const text = stripComments(fs.readFileSync(f, 'utf8'));
  codeCache.set(f, text);
  return text;
};

const sitesOf = (pkg: Scanned, re: RegExp) =>
  Object.fromEntries(
    pkg.files
      .map((f) => [pkg.rel(f), count(code(f), re)] as const)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
const expected = (list: Record<string, { sites: number }>) =>
  Object.fromEntries(
    Object.entries(list)
      .map(([f, v]) => [f, v.sites] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

describe("rab.actor_type = 'worker' is set only from trusted code (static)", () => {
  it('scans the real rab-server and rab-worker sources', () => {
    expect(SERVER.files.length).toBeGreaterThan(200);
    expect(WORKER.files.length).toBeGreaterThan(50);
    expect(SERVER.files.map(SERVER.rel)).toEqual(
      expect.arrayContaining([TENANT_CONTEXT_SERVICE, ...Object.keys(SERVER_ACTOR_TYPE_ALLOWLIST), ...Object.keys(SERVER_RAW_GUC_ALLOWLIST)]),
    );
    expect(WORKER.files.map(WORKER.rel)).toEqual(expect.arrayContaining([...Object.keys(WORKER_ACTOR_TYPE_ALLOWLIST), ...Object.keys(WORKER_RAW_GUC_ALLOWLIST)]));
  });

  it('the patterns recognise every form they claim to, and nothing else', () => {
    for (const form of [`actorType: 'worker'`, `actorType?: 'worker'`, `'actorType': "worker"`, 'ctx.actorType = `worker`', `{ role: '', actorType:'worker' }`]) {
      expect([form, count(form, ACTOR_TYPE_WORKER)]).toEqual([form, 1]);
    }
    for (const form of [`actorType: kind`, `actorType: ctx.actorType`, `ctx.actorType = role`, `c.actorType ??= x`, `c.actorType ||= x`, `c.actorType &&= x`, `actorType?: ActorType`]) {
      expect([form, count(form, ACTOR_TYPE_ASSIGNMENT)]).toEqual([form, 1]);
    }
    for (const form of [`ctx.actorType === 'worker'`, `ctx.actorType == x`, `ctx.actorType ?? ''`, `ctx.actorType !== 'worker'`, `Pick<AuthContext, 'actorType'>`]) {
      expect([form, count(form, ACTOR_TYPE_ASSIGNMENT)]).toEqual([form, 0]);
    }
    for (const form of [
      `SELECT set_config('rab.actor_type', 'worker', true)`,
      `SELECT pg_catalog.set_config( "rab.actor_type", $1, true)`,
      `SET LOCAL rab.actor_type = 'worker'`,
      `SET LOCAL "rab.actor_type" = 'worker'`,
      `set session rab.actor_type to 'worker'`,
      `SET rab.actor_type = 'worker'`,
    ]) {
      expect([form, count(form, RAW_ACTOR_TYPE_GUC)]).toEqual([form, 1]);
    }
    // Reading the marker is what the policies do; it is not a write.
    expect(count(`current_setting('rab.actor_type'::text, true) = 'worker'::text`, RAW_ACTOR_TYPE_GUC)).toBe(0);
  });

  it('comment stripping keeps strings: a "/*" inside a string or template cannot hide a later violation', () => {
    const source = [
      'const glob = `${__dirname}/migrations/*.{ts,js}`;',
      "const other = '/* not a comment';",
      "export const ctx = { actorType: 'worker' };",
      "const re = /\\/\\//; // trailing comment: actorType: 'worker'",
      "/* block comment: actorType: 'worker' */",
      "export const sql = `SELECT set_config('rab.actor_type', 'worker', true)`; // */",
    ].join('\n');
    const stripped = stripComments(source);
    expect(count(stripped, ACTOR_TYPE_WORKER)).toBe(1);
    expect(count(stripped, RAW_ACTOR_TYPE_GUC)).toBe(1);
    expect(stripped).toContain('`${__dirname}/migrations/*.{ts,js}`');
    expect(stripped).toContain("'/* not a comment'");
    expect(stripped).toContain('/\\/\\//;');
    expect(stripped).not.toContain('block comment');
    expect(stripped).not.toContain('trailing comment');
    // The defect this replaces: the old regex strip deleted everything from the glob's `/*` to the next `*/`, violation included.
    const oldStrip = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(count(oldStrip, ACTOR_TYPE_WORKER)).toBe(0);
  });

  it('rab-server: actorType is assigned only in the allowlisted files, exact counts, and only ever to the literal worker', () => {
    expect(sitesOf(SERVER, ACTOR_TYPE_ASSIGNMENT)).toEqual(expected(SERVER_ACTOR_TYPE_ALLOWLIST));
    expect(sitesOf(SERVER, ACTOR_TYPE_WORKER)).toEqual(expected(SERVER_ACTOR_TYPE_ALLOWLIST));
  });

  it('rab-worker: actorType is assigned only in the allowlisted files, exact counts, and only ever to the literal worker', () => {
    expect(sitesOf(WORKER, ACTOR_TYPE_ASSIGNMENT)).toEqual(expected(WORKER_ACTOR_TYPE_ALLOWLIST));
    expect(sitesOf(WORKER, ACTOR_TYPE_WORKER)).toEqual(expected(WORKER_ACTOR_TYPE_ALLOWLIST));
  });

  it('TenantContextService binds rab.actor_type from the context, in its one binding statement', () => {
    const text = code(path.join(SERVER_SRC, TENANT_CONTEXT_SERVICE));
    expect(count(text, RAW_ACTOR_TYPE_GUC)).toBe(1);
    expect(text).toMatch(/set_config\('rab\.actor_type', \$5, true\)/);
    expect(text).toMatch(/ctx\.actorType \?\? ''/);
    // The service never assigns the marker itself: only a trusted caller's context can carry it.
    expect(count(text, ACTOR_TYPE_ASSIGNMENT)).toBe(0);
  });

  it('rab-server: no raw set_config / SET of rab.actor_type outside TenantContextService (bar the listed maintenance tools)', () => {
    expect(sitesOf(SERVER, RAW_ACTOR_TYPE_GUC)).toEqual(expected({ [TENANT_CONTEXT_SERVICE]: { sites: 1 }, ...SERVER_RAW_GUC_ALLOWLIST }));
  });

  it('rab-worker: no raw set_config / SET of rab.actor_type (bar the listed maintenance tool)', () => {
    expect(sitesOf(WORKER, RAW_ACTOR_TYPE_GUC)).toEqual(expected(WORKER_RAW_GUC_ALLOWLIST));
  });

  it('every allowlist entry carries a reason', () => {
    for (const list of [SERVER_ACTOR_TYPE_ALLOWLIST, WORKER_ACTOR_TYPE_ALLOWLIST, SERVER_RAW_GUC_ALLOWLIST, WORKER_RAW_GUC_ALLOWLIST]) {
      for (const { why } of Object.values(list)) expect(why.length).toBeGreaterThan(20);
    }
  });
});
