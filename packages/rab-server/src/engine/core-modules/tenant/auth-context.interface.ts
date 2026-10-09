import { UserStatusType } from '@rab/shared';
import { ApplicationTarget } from '../auth/application-access';

/**
 * P1C (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program): the shape of the ONE canonical,
 * request-local PostgreSQL security snapshot `AuthSecuritySnapshotService` builds. Defined here,
 * alongside `AuthContext` itself, rather than in the service file — `TenantContextService`
 * (imported by that service) also imports `AuthContext` from THIS file, so importing the
 * service's own class file back from here would be a real module-resolution cycle (confirmed
 * directly: it broke NestJS's reflected constructor-parameter metadata for `JwtAuthGuard`,
 * resolving `AuthSecuritySnapshotService`'s injection token as `[Function: Object]` instead of
 * the real class). This file has no service-class dependencies at all, so it can never cycle back.
 */
export interface AuthSecuritySnapshot {
  userId: string;
  organisationId: string;
  workspaceId: string | null;
  accountStatus: UserStatusType;
  mustResetPassword: boolean;
  roles: string[];
  isPlatformAdmin: boolean;
  maintenanceModeEnabled: boolean;
  /** Every permission key this user currently holds, after role grants and per-user overrides have
   * already been resolved — `PermissionGuard` does a plain `.has(key)` lookup against this, no SQL. */
  effectivePermissions: ReadonlySet<string>;
}

/**
 * Derived from the verified access token by the (not-yet-built, M1) auth
 * guard chain — never from a request body. `organisationId` is null only
 * for a platform-level actor (`SUPER_ADMIN`) acting outside any tenant.
 */
export interface AuthContext {
  organisationId: string | null;
  /**
   * Resolved server-side on every request by `JwtAuthGuard` (via the live
   * session family and `core.workspace_membership`, through the SECURITY DEFINER
   * `core.resolve_membership_for_session`) — never read from the JWT or trusted from any client-supplied
   * value, per the Private Workspace migration's own JWT-cutover rule. Null
   * for an actor with no workspace of their own and no workspace membership
   * yet (a Manager mid-onboarding, or a Staff/Venue-Manager profile that
   * hasn't been backfilled). `organisationId` above stays populated in
   * parallel throughout Stage 2A's transition window (Revision 3 §1) —
   * dropped only in the migration's contract phase.
   */
  workspaceId: string | null;
  userId: string;
  role: string;
  /** The access token's `sid` claim — the refresh-token family this session belongs to. Used by the Devices list to mark "this device". */
  sessionId?: string;
  applicationTarget?: ApplicationTarget;
  /**
   * Set only by `JwtAuthGuard` when an `X-Inspect-Session-Id` header
   * resolves to a live `AdminInspectSession` belonging to the real,
   * verified token identity. Holds that real admin's user id, while
   * `userId`/`organisationId`/`role` above are rebuilt to the INSPECTED
   * target's identity so reads scope correctly. `PermissionGuard` rejects
   * any non-GET request whenever this is set, regardless of the admin's own
   * permissions — Admin Inspect is read-only. `AuditService.record()` always
   * attributes the actor to `inspectedBy` when present, never to `userId`.
   */
  inspectedBy?: string;
  /**
   * Set ONLY by trusted server code for a system worker scan (see the worker's workspace discovery). Never derived from a JWT, a request
   * body, a queue payload or Redis. Bound as rab.actor_type, which the staff_profile_worker_scan policy checks. Human contexts leave it
   * unset, so they never receive the worker read path.
   */
  actorType?: 'worker';
  /**
   * P1C (FULL-ARCHITECTURE-UPGRADE-PLAN.md — P1 program): the ONE canonical, request-local
   * PostgreSQL security snapshot `JwtAuthGuard` builds once per request via
   * `AuthSecuritySnapshotService` — account status, must-reset, roles, platform-admin,
   * maintenance mode, and effective permissions, all from one consistent point-in-time
   * transaction. Every later guard in the SAME request (`ActiveAccountGuard`,
   * `MustResetPasswordGuard`, `MaintenanceModeGuard`, `PermissionGuard`) reads this — never
   * recomputes it, never queries the database again for the same information. Request-local
   * only: never persisted, never read back on a later request, never stored outside this one
   * `AuthContext` instance. Absent only for a request `JwtAuthGuard` never ran on (there is none
   * today — every route that reaches a guard checking this already passed through it first).
   */
  security?: AuthSecuritySnapshot;
}
