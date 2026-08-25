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
}
