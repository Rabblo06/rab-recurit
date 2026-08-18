/**
 * Derived from the verified access token by the (not-yet-built, M1) auth
 * guard chain — never from a request body. `organisationId` is null only
 * for a platform-level actor (`SUPER_ADMIN`) acting outside any tenant.
 */
export interface AuthContext {
  organisationId: string | null;
  userId: string;
  role: string;
}
