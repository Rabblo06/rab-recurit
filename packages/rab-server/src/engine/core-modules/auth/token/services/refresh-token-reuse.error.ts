/**
 * Thrown when a refresh token that has already been rotated away
 * (`replacedBy` set) or revoked is presented again — the signature of a
 * stolen token being used after the legitimate client already rotated past
 * it. `RefreshTokenService.rotate()` deliberately does NOT revoke the family
 * itself before throwing — it runs inside `AuthService.refresh()`'s
 * transaction, which rolls back entirely on any thrown error, so a
 * revocation performed there would be undone along with everything else.
 * The catching code (`AuthService.refresh()`) is responsible for revoking
 * `familyId` in a fresh, separate transaction after this one has already
 * rolled back.
 */
export class RefreshTokenReuseError extends Error {
  constructor(public readonly familyId: string) {
    super('Refresh token reuse detected — token family revoked');
    this.name = 'RefreshTokenReuseError';
  }
}
