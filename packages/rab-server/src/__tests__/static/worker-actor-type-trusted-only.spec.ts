import * as fs from 'fs';
import * as path from 'path';

/**
 * `rab.actor_type = 'worker'` is an RLS marker: the `*_worker_scan` / `*_worker_select` / `*_worker_update` policies
 * (staff_profile, payroll_record, payroll_run, payroll_run_line, shift_staff_review, ...) open a wider read/write path to
 * any session that carries it. It must therefore be set ONLY by trusted server code for a system execution context with
 * no human actor, never from a JWT, a request body, a queue payload or Redis (auth-context.interface.ts, `actorType`).
 *
 * A static scan of rab-server's non-test sources (there is no ESLint here; "lint" = tsc), modelled on the T6-P3 spec
 * (ai-agents-no-execution.spec.ts). It fails when:
 *   1. `actorType: 'worker'` (or `= 'worker'`) appears in a file that is not on ACTOR_TYPE_WORKER_ALLOWLIST, or an
 *      allowlisted file gains or loses a site (exact counts, so the list can neither grow silently nor go stale);
 *   2. the GUC is written directly — `set_config('rab.actor_type', ...)` (any schema prefix or quoting) or
 *      `SET [LOCAL|SESSION] rab.actor_type` — anywhere but TenantContextService, apart from the two maintenance-tool
 *      sites on RAW_GUC_ALLOWLIST that predate this spec.
 * Comments are stripped first: several files explain the rule by naming the forbidden form.
 *
 * This is a tripwire, not a proof: a value assembled at run time (a constant holding 'worker', a GUC name passed as a
 * bound parameter) is not seen. Review still applies; this catches the plain copy-paste case.
 */
const SERVER_SRC = path.resolve(__dirname, '../..');

function sources(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts') && !d.name.endsWith('.spec.ts'))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !/[\\/]__tests__[\\/]/.test(f));
}
const rel = (f: string) => path.relative(SERVER_SRC, f).replace(/\\/g, '/');
/** Code only: comments may (and do) explain the rule by naming what is forbidden. */
const code = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (text: string, re: RegExp) => (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;

/** `actorType: 'worker'`, `actorType?: 'worker'`, `'actorType': "worker"`, `actorType = 'worker'`. */
const ACTOR_TYPE_WORKER = /['"]?\bactorType['"]?\s*\??\s*[:=]\s*['"`]worker['"`]/g;
/** `set_config('rab.actor_type'` with any prefix (`pg_catalog.`) and either quote; `SET [LOCAL|SESSION] rab.actor_type`. */
const RAW_ACTOR_TYPE_GUC = /set_config\s*\(\s*['"]rab\.actor_type['"]|\bSET\s+(?:LOCAL\s+|SESSION\s+)?rab\.actor_type\b/gi;

/**
 * Every rab-server file allowed to name the worker actor, with its exact number of sites and why.
 * (`rab-worker` has its own trusted sites — scoped-job.ts / workspace-discovery.ts and the scan jobs — and is not scanned here.)
 */
const ACTOR_TYPE_WORKER_ALLOWLIST: Record<string, { sites: number; why: string }> = {
  'engine/core-modules/tenant/auth-context.interface.ts': {
    sites: 1,
    why: 'the declaration itself (`actorType?: \'worker\'`): the only value the field can hold; sets nothing',
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

/** The single binding point every runtime context goes through (`bindGucsSql`, $5 = ctx.actorType). */
const TENANT_CONTEXT_SERVICE = 'engine/core-modules/tenant/tenant-context.service.ts';

/**
 * Raw writes of the GUC outside TenantContextService that predate this spec. Both are maintenance tools on their own
 * connection (not the request path), read-only in what they do with the marker, and documented in place. Listed so a
 * NEW raw site fails; whether these two should move behind TenantContextService is an owner decision, not made here.
 */
const RAW_GUC_ALLOWLIST: Record<string, { sites: number; why: string }> = {
  'database/typeorm/workspace-schema/backfill/hws-backfill.service.ts': {
    sites: 1,
    why: 'HWS backfill ops command, read identity on the crewflow connection (bindReadIdentity; see the class doc comment)',
  },
  'database/typeorm/workspace-schema/workspace-core-orphans.ts': {
    sites: 1,
    why: 'workspace -> core orphan check on a raw pg Client, BEGIN READ ONLY, counts only (SECURITY TRADE-OFF 0a-T2)',
  },
};

const ALL = sources(SERVER_SRC);
const sitesOf = (re: RegExp) =>
  Object.fromEntries(
    ALL.map((f) => [rel(f), count(code(f), re)] as const)
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
  it('scans the real rab-server sources, and the patterns recognise every form they claim to', () => {
    expect(ALL.length).toBeGreaterThan(200);
    expect(ALL.map(rel)).toEqual(expect.arrayContaining([TENANT_CONTEXT_SERVICE, ...Object.keys(ACTOR_TYPE_WORKER_ALLOWLIST), ...Object.keys(RAW_GUC_ALLOWLIST)]));
    for (const form of [`actorType: 'worker'`, `actorType?: 'worker'`, `'actorType': "worker"`, 'ctx.actorType = `worker`', `{ role: '', actorType:'worker' }`]) {
      expect(count(form, ACTOR_TYPE_WORKER)).toBe(1);
    }
    expect(count(`actorType: ctx.actorType`, ACTOR_TYPE_WORKER)).toBe(0);
    for (const form of [
      `SELECT set_config('rab.actor_type', 'worker', true)`,
      `SELECT pg_catalog.set_config( "rab.actor_type", $1, true)`,
      `SET LOCAL rab.actor_type = 'worker'`,
      `set session rab.actor_type to 'worker'`,
      `SET rab.actor_type = 'worker'`,
    ]) {
      expect(count(form, RAW_ACTOR_TYPE_GUC)).toBe(1);
    }
    // Reading the marker is what the policies do; it is not a write.
    expect(count(`current_setting('rab.actor_type'::text, true) = 'worker'::text`, RAW_ACTOR_TYPE_GUC)).toBe(0);
  });

  it("`actorType: 'worker'` appears only in the allowlisted files, with exactly the allowlisted number of sites", () => {
    expect(sitesOf(ACTOR_TYPE_WORKER)).toEqual(expected(ACTOR_TYPE_WORKER_ALLOWLIST));
  });

  it('TenantContextService binds rab.actor_type from the context, in its one binding statement', () => {
    const text = code(path.join(SERVER_SRC, TENANT_CONTEXT_SERVICE));
    expect(count(text, RAW_ACTOR_TYPE_GUC)).toBe(1);
    expect(text).toMatch(/set_config\('rab\.actor_type', \$5, true\)/);
    expect(text).toMatch(/ctx\.actorType \?\? ''/);
    // The service never hard-codes the worker value itself: only a trusted caller's context can carry it.
    expect(count(text, ACTOR_TYPE_WORKER)).toBe(0);
  });

  it('no raw set_config / SET of rab.actor_type outside TenantContextService (bar the two listed maintenance tools)', () => {
    expect(sitesOf(RAW_ACTOR_TYPE_GUC)).toEqual(expected({ [TENANT_CONTEXT_SERVICE]: { sites: 1 }, ...RAW_GUC_ALLOWLIST }));
  });

  it('every allowlist entry carries a reason', () => {
    for (const { why } of [...Object.values(ACTOR_TYPE_WORKER_ALLOWLIST), ...Object.values(RAW_GUC_ALLOWLIST)]) {
      expect(why.length).toBeGreaterThan(20);
    }
  });
});
