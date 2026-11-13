import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import * as fs from 'fs';
import * as path from 'path';
import { CanActivate, RequestMethod, Type } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { AppModule } from '../../app.module';
import { AuthProviderEnabledGuard } from '../../engine/core-modules/auth/guards/auth-provider-enabled.guard';
import { CredentialRequestProvenanceGuard } from '../../engine/core-modules/auth/guards/credential-request-provenance.guard';
import { JwtAuthGuard } from '../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../engine/guards/permission.guard';
import { RATE_LIMIT_REQUIRED } from '../../engine/core-modules/throttler/rab-throttler.guard';

/**
 * XA-07 (Phase X2, X6.3a): the authentication route inventory.
 *
 * Every HTTP route the real AppModule registers is discovered through Nest's own DiscoveryService and reflector metadata
 * (the same `path` / `method` / `__guards__` metadata Nest's router reads), and each one must either
 *   - run `JwtAuthGuard` as the FIRST guard of its effective chain (controller guards, then handler guards, which is the
 *     order Nest runs them in), so no guard that reads `request.authContext` (PermissionGuard, PlatformAdminGuard, the AI
 *     guards, ...) can run before the caller is authenticated; or
 *   - be listed in PUBLIC_ROUTES below, with the reason it is reachable without a session.
 * A new controller or handler that is neither fails this suite. So does an allow-list entry that no longer matches a
 * public route (removed, renamed, or now guarded), so the list cannot silently grow stale.
 *
 * The global throttler (APP_GUARD, RabThrottlerGuard) runs on every route and is not an authentication guard: it is not
 * part of the per-route `__guards__` metadata and is deliberately not counted here. The suite pins that it is the ONLY
 * global guard (APP_GUARD providers, no `useGlobalGuards(` in main.ts), so nothing global can silently authenticate, or
 * pre-empt, a route behind this inventory's back. It also pins the pre-auth controls the allow-list reasons name
 * (@RateLimitRequired, CredentialRequestProvenanceGuard for "trusted Origin") and that the HTTP controllers are the
 * whole surface (no GraphQL resolvers, no WebSocket gateways).
 */

/**
 * Routes reachable without a session. Each entry: `METHOD /path` → why it is public. Pre-auth routes are protected by
 * other controls (the throttler, @RateLimitRequired, signed/hashed single-use tokens, provider state), not by a session.
 */
const PRE_AUTH = 'pre-auth; per-IP throttled with @RateLimitRequired (Redis down = 503)';
const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  'GET /healthz': 'liveness/readiness probe for the orchestrator and uptime monitors; returns no tenant data',
  'GET /rest/v1/auth/config': 'sign-in page bootstrap (enabled providers, base domain); an unknown org slug answers like no slug',
  'GET /rest/v1/public/workspace-host': 'resolves which workspace a host name belongs to before sign-in; throttled, no tenant data',
  'POST /rest/v1/auth/login': `password sign-in (${PRE_AUTH}; trusted Origin via CredentialRequestProvenanceGuard)`,
  'POST /rest/v1/auth/refresh': `rotates a session from the refresh credential itself (${PRE_AUTH})`,
  'POST /rest/v1/auth/forgot-password': `uniform 204 for every address (${PRE_AUTH})`,
  'POST /rest/v1/auth/reset-password': `the only credential is the single-use hashed reset token in the body (${PRE_AUTH})`,
  'POST /rest/v1/auth/activate-account': `the only credential is the single-use hashed setup token in the body (${PRE_AUTH})`,
  'POST /rest/v1/auth/mfa/challenge/verify': `second factor of a sign-in in progress; credential = the single-use challenge token (${PRE_AUTH}; trusted Origin)`,
  'POST /rest/v1/auth/mfa/challenge/enrolment': `forced enrolment inside a sign-in challenge (${PRE_AUTH}; trusted Origin)`,
  'POST /rest/v1/auth/mfa/challenge/enrolment/confirm': `confirms that enrolment with a code (${PRE_AUTH}; trusted Origin)`,
  'POST /rest/v1/auth/mfa/challenge/cancel': `abandons a sign-in challenge (${PRE_AUTH}; trusted Origin)`,
  'POST /rest/v1/auth/login-handoff/peek': `cross-host login hand-off, read-only; credential = the single-use token in the body (${PRE_AUTH}; trusted Origin)`,
  'POST /rest/v1/auth/login-handoff/exchange': `cross-host login hand-off; credential = the single-use token in the body (${PRE_AUTH}; trusted Origin)`,
  'GET /rest/v1/auth/oauth/handoff': `one-time OAuth hand-off; credential = the HttpOnly crewflow_oauth_handoff cookie (${PRE_AUTH})`,
  'POST /rest/v1/auth/oauth/complete': `issues the session from the OAuth hand-off cookie; Origin allow-list enforced in the handler (assertTrustedOrigin) (${PRE_AUTH})`,
  'POST /rest/v1/auth/oauth/cancel': `drops the OAuth hand-off cookie; Origin allow-list enforced in the handler (assertTrustedOrigin) (${PRE_AUTH})`,
  'GET /rest/v1/auth/google': `starts Google sign-in (system gate AuthProviderEnabledGuard; ${PRE_AUTH})`,
  'GET /rest/v1/auth/google/callback': `Google OIDC callback; state/PKCE in core.oauth_transaction_state (${PRE_AUTH})`,
  'POST /rest/v1/auth/google/invitation': `starts Google sign-up for an invitation; credential = the invitation token (${PRE_AUTH})`,
  'GET /rest/v1/auth/microsoft': `starts Microsoft sign-in (system gate AuthProviderEnabledGuard; ${PRE_AUTH})`,
  'GET /rest/v1/auth/microsoft/callback': `Microsoft OIDC callback; state/PKCE in core.oauth_transaction_state (${PRE_AUTH})`,
  'POST /rest/v1/auth/microsoft/invitation': `starts Microsoft sign-up for an invitation; credential = the invitation token (${PRE_AUTH})`,
  'POST /rest/v1/email-change/confirm': `confirms an e-mail change from the link; credential = the single-use token in the body (${PRE_AUTH}; trusted Origin)`,
  'POST /rest/v1/invitations/resolve': `shows a member invitation before sign-up; credential = the invitation token (${PRE_AUTH})`,
  'POST /rest/v1/invitations/accept': `accepts a member invitation (creates the account); credential = the invitation token (${PRE_AUTH})`,
};

/** Public routes deliberately NOT behind @RateLimitRequired (read-only, no credential checked): the global throttler only. */
const PUBLIC_WITHOUT_RATE_LIMIT_REQUIRED: ReadonlySet<string> = new Set([
  'GET /healthz',
  'GET /rest/v1/auth/config',
  'GET /rest/v1/public/workspace-host',
]);

/**
 * Guards allowed to run BEFORE JwtAuthGuard because they never read `request.authContext`. A mixin guard
 * (`AuthProviderEnabledGuard('google')`, `PermissionGuard(flag)`) gets a random class name from Nest's `mixin()`, so it is
 * recognised by the factory that made it: the same `canActivate` source as a reference instance of that factory.
 */
const PRE_AUTH_SAFE_GUARDS: ReadonlySet<string> = new Set<string>([
  CredentialRequestProvenanceGuard.name, // Origin / content-type provenance only
  'AuthProviderEnabledGuard', // reads the deployment env flag only
]);
const MIXIN_FACTORIES: ReadonlyArray<{ name: string; reference: Type<CanActivate> }> = [
  { name: 'AuthProviderEnabledGuard', reference: AuthProviderEnabledGuard('google') },
  { name: 'PermissionGuard', reference: PermissionGuard(PermissionFlag.STAFF_VIEW) },
];

interface DiscoveredRoute {
  key: string;
  controller: string;
  handler: string;
  guards: Array<Type<CanActivate> | CanActivate>;
  rateLimitRequired: boolean;
}

function joinPath(...parts: Array<string | undefined>): string {
  const joined = parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/');
  return `/${joined}`;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function guardName(guard: Type<CanActivate> | CanActivate): string {
  const type = (typeof guard === 'function' ? guard : guard.constructor) as Type<CanActivate>;
  const source = String(type.prototype?.canActivate ?? '');
  const factory = MIXIN_FACTORIES.find((f) => source.length > 0 && source === String(f.reference.prototype.canActivate));
  return factory ? factory.name : type.name;
}

function discoverRoutes(moduleRef: TestingModule): DiscoveredRoute[] {
  const discovery = moduleRef.get(DiscoveryService);
  const reflector = moduleRef.get(Reflector);
  const scanner = new MetadataScanner();
  const routes: DiscoveredRoute[] = [];
  const seen = new Set<Type<unknown>>();
  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype as Type<unknown> | undefined;
    if (!controller || seen.has(controller)) continue;
    seen.add(controller);
    const controllerPaths = asArray(reflector.get<string | string[] | undefined>(PATH_METADATA, controller));
    const controllerGuards = reflector.get<Array<Type<CanActivate> | CanActivate> | undefined>(GUARDS_METADATA, controller) ?? [];
    for (const methodName of scanner.getAllMethodNames(controller.prototype)) {
      const handler = (controller.prototype as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function') continue;
      const methodPaths = reflector.get<string | string[] | undefined>(PATH_METADATA, handler as never);
      if (methodPaths === undefined) continue; // not a route handler
      const requestMethod = reflector.get<RequestMethod | undefined>(METHOD_METADATA, handler as never) ?? RequestMethod.GET;
      const handlerGuards = reflector.get<Array<Type<CanActivate> | CanActivate> | undefined>(GUARDS_METADATA, handler as never) ?? [];
      for (const cPath of controllerPaths.length ? controllerPaths : ['']) {
        for (const mPath of asArray(methodPaths)) {
          routes.push({
            key: `${RequestMethod[requestMethod]} ${joinPath(cPath, mPath)}`,
            controller: controller.name,
            handler: methodName,
            guards: [...controllerGuards, ...handlerGuards],
            // Read exactly as RabThrottlerGuard reads it: handler first, then class.
            rateLimitRequired: reflector.getAllAndOverride<boolean>(RATE_LIMIT_REQUIRED, [handler as never, controller]) === true,
          });
        }
      }
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}

/** Null when the route authenticates first; otherwise why it does not. */
function authenticationProblem(route: DiscoveredRoute): string | null {
  const index = route.guards.findIndex((g) => g === JwtAuthGuard);
  if (index < 0) return `no JwtAuthGuard (guards: ${route.guards.map(guardName).join(', ') || 'none'})`;
  const before = route.guards.slice(0, index).map(guardName).filter((name) => !PRE_AUTH_SAFE_GUARDS.has(name));
  if (before.length) return `runs ${before.join(', ')} BEFORE JwtAuthGuard`;
  return null;
}

describe('auth route inventory (XA-07): every route authenticates first or is explicitly public', () => {
  let moduleRef: TestingModule;
  let routes: DiscoveredRoute[];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    routes = discoverRoutes(moduleRef);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('discovers the real route table (sanity: the scan is not vacuous)', () => {
    expect(routes.length).toBeGreaterThan(100);
    const keys = new Set(routes.map((r) => r.key));
    expect(keys).toContain('POST /rest/v1/auth/login');
    expect(keys).toContain('GET /rest/v1/auth/me');
    // No two handlers claim the same method + path (that would make the inventory ambiguous).
    expect(keys.size).toBe(routes.length);
  });

  it('every route not on the public allow-list runs JwtAuthGuard first', () => {
    const offenders = routes
      .filter((r) => !(r.key in PUBLIC_ROUTES))
      .map((r) => ({ r, problem: authenticationProblem(r) }))
      .filter((x) => x.problem !== null)
      .map((x) => `${x.r.key}  (${x.r.controller}.${x.r.handler}): ${x.problem}`);
    expect(offenders).toEqual([]);
  });

  it('every public allow-list entry is a real route that really has no JwtAuthGuard (no stale or redundant entries)', () => {
    const byKey = new Map(routes.map((r) => [r.key, r]));
    const stale = Object.keys(PUBLIC_ROUTES).filter((key) => !byKey.has(key));
    const redundant = Object.keys(PUBLIC_ROUTES).filter((key) => byKey.get(key)?.guards.includes(JwtAuthGuard));
    expect({ stale, redundant }).toEqual({ stale: [], redundant: [] });
  });

  it('every public allow-list entry states a reason', () => {
    const missing = Object.entries(PUBLIC_ROUTES)
      .filter(([, reason]) => reason.trim().length < 10)
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('every public route except health, auth config and workspace-host carries @RateLimitRequired (Redis down = 503)', () => {
    const byKey = new Map(routes.map((r) => [r.key, r]));
    const missing = Object.keys(PUBLIC_ROUTES).filter((key) => !PUBLIC_WITHOUT_RATE_LIMIT_REQUIRED.has(key) && !byKey.get(key)?.rateLimitRequired);
    expect(missing).toEqual([]);
    // The reason text and the metadata agree: an entry that claims @RateLimitRequired has it.
    const claimed = Object.entries(PUBLIC_ROUTES)
      .filter(([key, reason]) => reason.includes('@RateLimitRequired') && !byKey.get(key)?.rateLimitRequired)
      .map(([key]) => key);
    expect(claimed).toEqual([]);
  });

  it('every public route whose reason says "trusted Origin" runs CredentialRequestProvenanceGuard', () => {
    const byKey = new Map(routes.map((r) => [r.key, r]));
    const claims = Object.entries(PUBLIC_ROUTES).filter(([, reason]) => reason.includes('trusted Origin'));
    expect(claims.length).toBeGreaterThan(0);
    const missing = claims.filter(([key]) => !byKey.get(key)?.guards.includes(CredentialRequestProvenanceGuard)).map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('the only global (APP_GUARD) guard is RabThrottlerGuard', () => {
    const discovery = moduleRef.get(DiscoveryService);
    const globalGuards = discovery
      .getProviders()
      .filter((wrapper) => typeof wrapper.token === 'string' && wrapper.token.startsWith('APP_GUARD'))
      .map((wrapper) => (wrapper.metatype as Type<unknown> | undefined)?.name ?? String(wrapper.token))
      .sort();
    expect(globalGuards).toEqual(['RabThrottlerGuard']);
  });

  it('main.ts registers no global guard outside the module graph (no useGlobalGuards)', () => {
    const main = fs.readFileSync(path.resolve(__dirname, '../../main.ts'), 'utf8');
    expect(main).not.toMatch(/useGlobalGuards\s*\(/);
  });

  it('HTTP controllers are the whole surface: no GraphQL or WebSocket dependency, no resolvers, no gateways', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    expect(Object.keys(deps).filter((name) => /^@nestjs\/(graphql|apollo|mercurius|websockets|platform-socket\.io|platform-ws)$/.test(name))).toEqual([]);
    const discovery = moduleRef.get(DiscoveryService);
    const surfaces = [...discovery.getProviders(), ...discovery.getControllers()]
      .map((wrapper) => wrapper.metatype as Type<unknown> | undefined)
      .filter((type): type is Type<unknown> => typeof type === 'function')
      .filter((type) => Reflect.getMetadata('graphql:resolver_type', type) !== undefined || Reflect.getMetadata('websockets:is_gateway', type) === true)
      .map((type) => type.name);
    expect(surfaces).toEqual([]);
  });
});
