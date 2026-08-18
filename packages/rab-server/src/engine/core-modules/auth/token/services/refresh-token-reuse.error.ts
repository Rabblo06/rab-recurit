/**
 * Thrown when a refresh token that has already been rotated away
 * (`replacedBy` set) or revoked is presented again — the signature of a
 * stolen token being used after the legitimate client already rotated past
 * it. The whole token family has already been revoked by the time this is
 * thrown; the caller's job is only to audit it (`AUTH_REFRESH_REUSE`).
 */
export class RefreshTokenReuseError extends Error {
  constructor(public readonly familyId: string) {
    super('Refresh token reuse detected — token family revoked');
    this.name = 'RefreshTokenReuseError';
  }
}
