import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import { INestApplication, Type } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { CONSUMER_QUEUES } from '../../engine/worker-shared/queue-registry';
import { ROLE_DEFS } from '../../modules/manager/services/manager.service';
import { STAFF_ROLE_PERMISSIONS } from '../../modules/staff/services/staff.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import {
  MATRIX_CELLS,
  MATRIX_ROLES,
  MatrixCell,
  MatrixRole,
  PATH_PARAM_SAMPLES,
  PERMISSION_MATRIX,
  PROBE_EXECUTES_HANDLER,
} from './permission-matrix/permission-matrix.data';
import { AI_OFF_GUARDS, MatrixRoleProfile, MatrixRoute, PASS_THROUGH_GUARDS, discoverMatrixRoutes, suggestCell } from './permission-matrix/route-discovery';

/**
 * The permission matrix (rab-workforce-architecture.md §7): every authenticated route x every role, from ONE reviewed data
 * file (permission-matrix/permission-matrix.data.ts), checked against the live route table and against live requests.
 *
 *  1. Coverage. The routes are discovered from the real AppModule (DiscoveryService, the metadata Nest's router reads, as
 *     auth-route-inventory does). A route that runs JwtAuthGuard and has no matrix row fails, with a suggested row derived
 *     from its guards; a row for a route that no longer exists fails too.
 *  2. Live outcome. Each role signs in as a real client of that role would (production role defaults, its own
 *     application), then every row is requested as every role and the response must match the cell.
 *
 * The probe never lets a mutation reach its handler (so the suite has no side effects to order or clean up):
 *   - a route with a record id (`:id`, `:staffId`, ...) gets a malformed id: the guards run first (403 / guard 404), and a
 *     request that passes them is answered 404 by UuidPathParamsInterceptor before any pipe or handler runs;
 *   - a mutation with a validated body DTO gets a body with one undeclared property: a request that passes the guards is
 *     answered 400 by the global ValidationPipe (forbidNonWhitelisted) before the handler;
 *   - a GET without a record id runs for real (reads only);
 *   - the few mutations that have neither are listed, each with a decision, in PROBE_EXECUTES_HANDLER.
 * So `ok` means "every guard layer let this identity through". Per-record scope (404 for another tenant's, venue's or
 * person's record) is proved by the abuse-case suites; this suite proves layer 1 for every route at once.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

const MALFORMED_RECORD_ID = 'matrix-probe-not-a-uuid';
const UNDECLARED_BODY = { matrixProbeUndeclaredProperty: true };

type Probe = 'record' | 'body' | 'read' | 'handler';

interface Observation {
  status: number;
  code?: string;
  message?: string;
}

function probeOf(route: MatrixRoute): Probe {
  if (route.recordParams.length > 0) return 'record';
  if (route.method === 'GET') return 'read';
  if (route.validatedBody) return 'body';
  return 'handler';
}

/** The cell a response stands for under the given probe (see the header): null = never acceptable (401, 429, 5xx). */
function cellOf(probe: Probe, observed: Observation): MatrixCell | null {
  const { status } = observed;
  if (status === 403) return '403';
  if (status === 401 || status === 429 || status >= 500 || status === 0) return null;
  if (status === 404) {
    // A record probe that passes the guards is answered by UuidPathParamsInterceptor: a plain NotFoundException without a
    // `code`. A guard that hides a route (AI off) answers 404 WITH a code, before the interceptor ever runs.
    if (probe === 'record' && observed.code === undefined) return 'ok';
    return '404';
  }
  return 'ok';
}

function parseRow(key: string, row: string): Record<MatrixRole, string> {
  const cells = row.trim().split(/\s+/);
  if (cells.length !== MATRIX_ROLES.length) throw new Error(`${key}: ${cells.length} cells, expected ${MATRIX_ROLES.length}`);
  return Object.fromEntries(MATRIX_ROLES.map((role, i) => [role, cells[i]!])) as Record<MatrixRole, string>;
}

describeIfDb('permission matrix (§7): every authenticated route x every role', () => {
  jest.setTimeout(600_000);

  let moduleRef: TestingModule;
  let app: INestApplication;
  let owner: DataSource;
  let baseUrl: URL;
  let routes: MatrixRoute[];
  let authenticated: MatrixRoute[];
  const tokens = {} as Record<MatrixRole, string>;

  const PROFILES: Record<MatrixRole, MatrixRoleProfile> = {
    platform_admin: { applicationTarget: 'manager_web', flags: new Set(ROLE_DEFS.ceo!.permissions), platformAdmin: true },
    ceo: { applicationTarget: 'manager_web', flags: new Set(ROLE_DEFS.ceo!.permissions), platformAdmin: false },
    manager: { applicationTarget: 'manager_web', flags: new Set(ROLE_DEFS.internal!.permissions), platformAdmin: false },
    venue_manager: { applicationTarget: 'venue_manager_app', flags: new Set(ROLE_DEFS.venue!.permissions), platformAdmin: false },
    staff: { applicationTarget: 'staff_app', flags: new Set<string>(STAFF_ROLE_PERMISSIONS), platformAdmin: false },
  };
  const SAMPLES: Record<string, string> = { ...PATH_PARAM_SAMPLES, queue: CONSUMER_QUEUES.email.name };

  function urlFor(route: MatrixRoute): string {
    return route.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
      if (route.recordParams.includes(name)) return MALFORMED_RECORD_ID;
      const sample = SAMPLES[name];
      if (sample === undefined) throw new Error(`${route.key}: no PATH_PARAM_SAMPLES value for :${name}`);
      return encodeURIComponent(sample);
    });
  }

  /** One request over a real socket; resolves at the response head for a stream, after the body otherwise. */
  function send(route: MatrixRoute, token: string): Promise<Observation> {
    const probe = probeOf(route);
    const payload = probe === 'body' ? JSON.stringify(UNDECLARED_BODY) : route.method === 'GET' || route.method === 'DELETE' ? undefined : '{}';
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: route.sse ? 'text/event-stream' : 'application/json' };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: baseUrl.hostname.replace(/^\[|\]$/g, ''), port: baseUrl.port, method: route.method, path: urlFor(route), headers, timeout: 60_000 },
        (res) => {
          const status = res.statusCode ?? 0;
          if (route.sse && status === 200) {
            res.destroy(); // an open event stream: the head is the answer
            req.destroy();
            resolve({ status });
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: { code?: unknown; message?: unknown } = {};
            try {
              body = text ? (JSON.parse(text) as typeof body) : {};
            } catch {
              body = {};
            }
            resolve({
              status,
              code: typeof body.code === 'string' ? body.code : undefined,
              message: typeof body.message === 'string' ? body.message : Array.isArray(body.message) ? body.message.join('; ') : undefined,
            });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`timeout ${route.key}`)));
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    await app.listen(0, '127.0.0.1'); // a real socket: the event-stream route is read up to its response head
    baseUrl = new URL(await app.getUrl());
    owner = createAdminDataSource();
    await owner.initialize();

    const controllers = moduleRef
      .get(DiscoveryService)
      .getControllers()
      .map((wrapper) => wrapper.metatype as Type<unknown> | undefined)
      .filter((type): type is Type<unknown> => typeof type === 'function');
    routes = discoverMatrixRoutes(controllers);
    authenticated = routes.filter((r) => r.guards.some((g) => g.kind === 'jwt'));

    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    // The platform administrator is the CEO of its own organisation (as the bootstrap CLI makes it); the other four share
    // one organisation, the Venue Manager and the Staff member inside the Internal Manager's workspace.
    const platformAdmin = await factory.createCeo(await factory.createOrganisation('pmx-padm'), { platformAdmin: true });
    const org = await factory.createOrganisation('pmx');
    const ceo = await factory.createCeo(org);
    const manager = await factory.createInternalManager(org);
    const venueManager = await factory.createVenueManager(org, { owner: manager });
    const staff = await factory.createStaff(org, { owner: manager });
    const identities: Record<MatrixRole, TestIdentity> = { platform_admin: platformAdmin, ceo, manager, venue_manager: venueManager, staff };
    for (const role of MATRIX_ROLES) tokens[role] = await factory.login(identities[role]);
  }, 300_000);

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('discovers the real route table (sanity: the scan is not vacuous)', () => {
    expect(authenticated.length).toBeGreaterThan(300);
    const keys = new Set(routes.map((r) => r.key));
    expect(keys.size).toBe(routes.length);
    expect(keys).toContain('GET /rest/v1/auth/me');
    const staffList = routes.find((r) => r.key === 'GET /rest/v1/staff');
    expect(staffList?.guards.find((g) => g.kind === 'permission')?.flags).toEqual([PermissionFlag.STAFF_VIEW]);
  });

  it('every authenticated route has a matrix row (classify a new endpoint in permission-matrix.data.ts)', () => {
    const missing = authenticated.filter((r) => !(r.key in PERMISSION_MATRIX));
    const suggestions = missing.map((r) => `  '${r.key}': '${MATRIX_ROLES.map((role) => suggestCell(r, PROFILES[role]).padEnd(4)).join(' ').trimEnd()}',`);
    // Suggested rows come from the guards alone; review each cell against §7 before pasting it.
    expect(suggestions).toEqual([]);
  });

  it('every matrix row is a real authenticated route (no stale rows, no public routes)', () => {
    const byKey = new Map(routes.map((r) => [r.key, r]));
    const stale = Object.keys(PERMISSION_MATRIX).filter((key) => !byKey.has(key));
    const publicRows = Object.keys(PERMISSION_MATRIX).filter((key) => byKey.has(key) && !byKey.get(key)!.guards.some((g) => g.kind === 'jwt'));
    expect({ stale, publicRows }).toEqual({ stale: [], publicRows: [] });
  });

  it('every row has exactly one valid cell per role', () => {
    const bad: string[] = [];
    for (const [key, row] of Object.entries(PERMISSION_MATRIX)) {
      try {
        const cells = parseRow(key, row);
        for (const role of MATRIX_ROLES) if (!(MATRIX_CELLS as readonly string[]).includes(cells[role])) bad.push(`${key}: ${role} = ${cells[role]}`);
      } catch (error) {
        bad.push((error as Error).message);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the mutations a probe cannot stop before their handler are exactly the ones listed with a decision', () => {
    const actual = authenticated.filter((r) => probeOf(r) === 'handler').map((r) => r.key).sort();
    expect(actual).toEqual(Object.keys(PROBE_EXECUTES_HANDLER).sort());
  });

  it('every guard on an authenticated route is one the matrix probe models (a new guard needs a decision here)', () => {
    const modelled = new Set(['PlatformAdminGuard', ...PASS_THROUGH_GUARDS, ...AI_OFF_GUARDS]);
    const unknown = [...new Set(authenticated.flatMap((r) => r.guards.filter((g) => g.kind === 'other' && !modelled.has(g.name)).map((g) => `${g.name} on ${r.key}`)))];
    expect(unknown).toEqual([]);
    // Every permission mixin was read: an empty flag list would mean the recording probe no longer sees the flag.
    const unread = authenticated.filter((r) => r.guards.some((g) => (g.kind === 'permission' || g.kind === 'any-permission') && g.flags.length === 0)).map((r) => r.key);
    expect(unread).toEqual([]);
  });

  describe('§7 invariants, read from the matrix rows', () => {
    const rows = () => Object.entries(PERMISSION_MATRIX).map(([key, row]) => ({ key, path: key.split(' ')[1]!, cells: parseRow(key, row) }));

    it('only a platform administrator reaches /rest/v1/admin/** (system settings, platform operations)', () => {
      const leaks = rows()
        .filter((r) => r.path.startsWith('/rest/v1/admin/'))
        .flatMap((r) => MATRIX_ROLES.filter((role) => role !== 'platform_admin' && r.cells[role] === 'ok').map((role) => `${r.key}: ${role}`));
      expect(leaks).toEqual([]);
    });

    it('Venue Managers and Staff never reach the payroll console; Staff reach only their own payslips', () => {
      const leaks = rows()
        .filter((r) => r.path.startsWith('/rest/v1/payroll'))
        .flatMap((r) => {
          const own = r.path.startsWith('/rest/v1/payroll/me/');
          return [...(r.cells.venue_manager === 'ok' ? [`${r.key}: venue_manager`] : []), ...(r.cells.staff === 'ok' && !own ? [`${r.key}: staff`] : [])];
        });
      expect(leaks).toEqual([]);
    });

    it('clock in / clock out are Staff-only (§7: managers never clock for themselves)', () => {
      const clock = rows().filter((r) => /^\/rest\/v1\/attendance\/(check-in|clock-in|clock-out|geofence-exit)$/.test(r.path));
      expect(clock.length).toBe(4);
      expect(clock.filter((r) => MATRIX_ROLES.some((role) => (role === 'staff') !== (r.cells[role] === 'ok'))).map((r) => r.key)).toEqual([]);
    });

    it('Staff never reach audit logs, roles or manager administration', () => {
      const leaks = rows()
        .filter((r) => /^\/rest\/v1\/(audit|roles|managers)(\/|$)/.test(r.path) && r.cells.staff === 'ok')
        .map((r) => r.key);
      expect(leaks).toEqual([]);
    });
  });

  it('every role gets its cell on every route, live', async () => {
    const order = (r: MatrixRoute) => (probeOf(r) !== 'handler' ? 0 : PROBE_EXECUTES_HANDLER[r.key] === 'run-last' ? 2 : 1);
    const plan = authenticated.filter((r) => r.key in PERMISSION_MATRIX).sort((a, b) => order(a) - order(b) || a.key.localeCompare(b.key));
    const mismatches: string[] = [];
    // Roles run concurrently (independent identities); one role's requests run in order.
    await Promise.all(
      MATRIX_ROLES.map(async (role) => {
        for (const route of plan) {
          const expected = parseRow(route.key, PERMISSION_MATRIX[route.key]!)[role];
          const observed = await send(route, tokens[role]);
          const actual = cellOf(probeOf(route), observed);
          if (actual !== expected) {
            mismatches.push(
              `${route.key} | ${role} | expected ${expected} | got ${observed.status} (${probeOf(route)}) ${observed.code ?? ''} ${(observed.message ?? '').slice(0, 120)}`.trimEnd(),
            );
          }
        }
      }),
    );
    expect(mismatches.sort()).toEqual([]);
  });
});
