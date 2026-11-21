import 'reflect-metadata';
import { PermissionFlag } from '@rab/shared';
import { CanActivate, RequestMethod, Type } from '@nestjs/common';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { MANAGER_APPLICATION } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { MOBILE_APPLICATION } from '../../../engine/core-modules/auth/guards/mobile-application.decorator';
import { AuthProviderEnabledGuard } from '../../../engine/core-modules/auth/guards/auth-provider-enabled.guard';
import { AnyPermissionGuard } from '../../../engine/guards/any-permission.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';

/**
 * Route discovery for the permission matrix (permission-matrix.integration.spec.ts). Reads the same Nest metadata the router
 * reads (path, method, guards, route arguments) plus the two application decorators JwtAuthGuard enforces, so the matrix
 * covers exactly the routes the API really serves. No database, no HTTP: pure reflection over controller classes.
 */

export type MatrixGuardKind = 'jwt' | 'permission' | 'any-permission' | 'other';

export interface MatrixGuard {
  kind: MatrixGuardKind;
  /** Class name for 'other'; 'PermissionGuard' / 'AnyPermissionGuard' for the mixins (whose class names are random). */
  name: string;
  /** The flag(s) a PermissionGuard / AnyPermissionGuard mixin checks (read by running it against a recording set). */
  flags: string[];
}

export interface MatrixRoute {
  /** `METHOD /path`, the key the matrix file uses. */
  key: string;
  method: string;
  path: string;
  controller: string;
  handler: string;
  guards: MatrixGuard[];
  /** `@ManagerApplication()`: only a `manager_web` session. */
  managerApplicationOnly: boolean;
  /** `@MobileApplication(...)`: the mobile application targets this route accepts (empty: none, mobile is default-denied). */
  mobileTargets: string[];
  /** Path parameters that name a record (`:id`, `:staffId`, ...): UuidPathParamsInterceptor answers 404 for a malformed one. */
  recordParams: string[];
  /** Other path parameters (`:token`, `:provider`, ...). */
  otherParams: string[];
  /** The handler validates its whole body against a class DTO (the global ValidationPipe rejects an undeclared property). */
  validatedBody: boolean;
  /** `@Sse()` stream. */
  sse: boolean;
}

const RECORD_PARAM_PATTERN = /^id$|Id$/; // the same pattern UuidPathParamsInterceptor uses
const PRIMITIVES: ReadonlySet<unknown> = new Set([Object, String, Number, Boolean, Array, Buffer]);

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function joinPath(...parts: Array<string | undefined>): string {
  const joined = parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/');
  return `/${joined}`;
}

/**
 * A mixin guard (`PermissionGuard(flag)`) gets a random class name from Nest's `mixin()`, so it is recognised by the factory
 * that made it: the same `canActivate` source as a reference instance of that factory (auth-route-inventory does the same).
 */
const PERMISSION_SOURCE = String(PermissionGuard(PermissionFlag.STAFF_VIEW).prototype.canActivate);
const ANY_PERMISSION_SOURCE = String(AnyPermissionGuard(PermissionFlag.STAFF_VIEW).prototype.canActivate);
const AUTH_PROVIDER_SOURCE = String(AuthProviderEnabledGuard('google').prototype.canActivate);

/**
 * The flag(s) a permission mixin checks. The mixin closes over its flag and exposes nothing, so it is run once against a
 * request whose effective-permission set records every `has()` call and holds nothing: the guard then throws 403 having
 * asked for exactly its flag(s).
 */
function flagsOfPermissionMixin(type: Type<CanActivate>): string[] {
  const asked: string[] = [];
  const recordingSet = { has: (flag: string) => (asked.push(flag), false) };
  const request = { method: 'GET', authContext: { security: { effectivePermissions: recordingSet } } };
  const context = { switchToHttp: () => ({ getRequest: () => request }) };
  const guard = new (type as unknown as new (permissions: unknown) => CanActivate)({});
  try {
    const result = guard.canActivate(context as never);
    if (result instanceof Promise) {
      // Both mixins resolve synchronously on the snapshot path; a promise here means the guard changed shape.
      result.catch(() => undefined);
    }
  } catch {
    // ForbiddenException: expected, the recording set holds nothing.
  }
  return asked;
}

export function describeGuard(guard: Type<CanActivate> | CanActivate): MatrixGuard {
  const type = (typeof guard === 'function' ? guard : guard.constructor) as Type<CanActivate>;
  if (type === JwtAuthGuard) return { kind: 'jwt', name: 'JwtAuthGuard', flags: [] };
  const source = String(type.prototype?.canActivate ?? '');
  if (source === PERMISSION_SOURCE) return { kind: 'permission', name: 'PermissionGuard', flags: flagsOfPermissionMixin(type) };
  if (source === ANY_PERMISSION_SOURCE) return { kind: 'any-permission', name: 'AnyPermissionGuard', flags: flagsOfPermissionMixin(type) };
  if (source === AUTH_PROVIDER_SOURCE) return { kind: 'other', name: 'AuthProviderEnabledGuard', flags: [] };
  return { kind: 'other', name: type.name, flags: [] };
}

/** Whether argument `index` of the handler is `@Body()` (whole body) typed with a class DTO. */
function hasValidatedBody(controller: Type<unknown>, methodName: string): boolean {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, methodName) ?? {}) as Record<string, { index: number; data?: unknown }>;
  const paramTypes = (Reflect.getMetadata('design:paramtypes', controller.prototype, methodName) ?? []) as unknown[];
  return Object.entries(args).some(([key, arg]) => {
    if (key.split(':')[0] !== String(RouteParamtypes.BODY) || arg.data !== undefined) return false;
    const type = paramTypes[arg.index];
    return typeof type === 'function' && !PRIMITIVES.has(type);
  });
}

/** Every route of the given controller classes, sorted by key. */
export function discoverMatrixRoutes(controllers: Iterable<Type<unknown>>): MatrixRoute[] {
  const scanner = new MetadataScanner();
  const routes: MatrixRoute[] = [];
  const seen = new Set<Type<unknown>>();
  for (const controller of controllers) {
    if (seen.has(controller)) continue;
    seen.add(controller);
    const controllerPaths = asArray(Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined);
    const controllerGuards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as Array<Type<CanActivate> | CanActivate>;
    for (const methodName of scanner.getAllMethodNames(controller.prototype)) {
      const handler = (controller.prototype as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function') continue;
      const methodPaths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (methodPaths === undefined) continue; // not a route handler
      const requestMethod = (Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined) ?? RequestMethod.GET;
      const handlerGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<Type<CanActivate> | CanActivate>;
      // Read exactly as JwtAuthGuard reads them: handler first, then class (Reflector.getAllAndOverride).
      const managerOnly = (Reflect.getMetadata(MANAGER_APPLICATION, handler) ?? Reflect.getMetadata(MANAGER_APPLICATION, controller)) === true;
      const mobile = (Reflect.getMetadata(MOBILE_APPLICATION, handler) ?? Reflect.getMetadata(MOBILE_APPLICATION, controller)) as string[] | undefined;
      for (const cPath of controllerPaths.length ? controllerPaths : ['']) {
        for (const mPath of asArray(methodPaths)) {
          const path = joinPath(cPath, mPath);
          const params = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
          const method = RequestMethod[requestMethod];
          routes.push({
            key: `${method} ${path}`,
            method,
            path,
            controller: controller.name,
            handler: methodName,
            guards: [...controllerGuards, ...handlerGuards].map(describeGuard),
            managerApplicationOnly: managerOnly,
            mobileTargets: [...(mobile ?? [])],
            recordParams: params.filter((p) => RECORD_PARAM_PATTERN.test(p)),
            otherParams: params.filter((p) => !RECORD_PARAM_PATTERN.test(p)),
            validatedBody: hasValidatedBody(controller, methodName),
            sse: Reflect.getMetadata(SSE_METADATA, handler) === true,
          });
        }
      }
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}

/** One matrix column: the identity a real client of that role signs in as. */
export interface MatrixRoleProfile {
  /** The application its session is bound to (`manager_web`, `venue_manager_app`, `staff_app`). */
  applicationTarget: string;
  /** The role's default permission set (code defaults, the same set a database built by migrations grants). */
  flags: ReadonlySet<string>;
  platformAdmin: boolean;
}

/**
 * Guards whose outcome for the matrix identities is known statically. Any other guard on a route makes the suggestion
 * `?`: a human reads the guard and classifies the cell (the live probe then proves the classification).
 *  - PlatformAdminGuard: 403 unless the identity holds the platform-admin claim.
 *  - PASS_THROUGH_GUARDS never refuse a matrix probe: every matrix identity has a workspace (RequireWorkspaceGuard); the
 *    test environment enables both OIDC providers (AuthProviderEnabledGuard, jest-setup.ts) and switches rate limits off
 *    (AttendancePerUserThrottleGuard); a probe body never asks for a CEO account (CeoCreationGuard).
 *  - AI_OFF_GUARDS: AI is off in the test environment (as in production), so every AI route answers 404 Not found
 *    (AiNotAvailableException), whoever asks.
 */
export const PASS_THROUGH_GUARDS: ReadonlySet<string> = new Set(['RequireWorkspaceGuard', 'AuthProviderEnabledGuard', 'AttendancePerUserThrottleGuard', 'CeoCreationGuard']);
export const AI_OFF_GUARDS: ReadonlySet<string> = new Set(['AiAvailableGuard', 'AiSettingsGuard', 'AiAgentsSwitchGuard', 'AiDecidableGuard', 'AiStreamAccessGuard']);

/**
 * The cell the guard chain implies for one identity: `ok` (every guard passes), `403` (exists, categorically not for this
 * identity), `404` (hidden), or `?` (a guard this function does not model). A suggestion for a human to review when a
 * new route appears, never the assertion itself: the matrix file is the reviewed intent and the live probe is the proof.
 */
export function suggestCell(route: MatrixRoute, role: MatrixRoleProfile): string {
  if (!route.guards.some((g) => g.kind === 'jwt')) return 'public';
  // JwtAuthGuard's application checks (in its order).
  if (route.managerApplicationOnly && role.applicationTarget !== 'manager_web') return '403';
  if (role.applicationTarget !== 'manager_web' && !route.mobileTargets.includes(role.applicationTarget)) return '403';
  for (const guard of route.guards) {
    if (guard.kind === 'jwt') continue;
    if (guard.kind === 'permission' && !guard.flags.every((f) => role.flags.has(f))) return '403';
    if (guard.kind === 'any-permission' && !guard.flags.some((f) => role.flags.has(f))) return '403';
    if (guard.kind !== 'other') continue;
    if (PASS_THROUGH_GUARDS.has(guard.name)) continue;
    if (guard.name === 'PlatformAdminGuard') {
      if (!role.platformAdmin) return '403';
      continue;
    }
    if (AI_OFF_GUARDS.has(guard.name)) return '404';
    return '?';
  }
  return 'ok';
}
