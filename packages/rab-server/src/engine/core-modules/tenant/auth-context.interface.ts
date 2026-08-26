/**
 * Derived from the verified access token by the (not-yet-built, M1) auth
 * guard chain — never from a request body. `organisationId` is null only
 * for a platform-level actor (`SUPER_ADMIN`) acting outside any tenant.
 */
export interface AuthContext {
  organisationId: string | null;
  userId: string;
  role: string;
  /** The access token's `sid` claim — the refresh-token family this session belongs to. Used by the Devices list to mark "this device". */
  sessionId?: string;
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
}
