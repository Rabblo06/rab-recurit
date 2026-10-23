import { ApplicationTarget, defaultApplication } from '../../application-access';
import { ACCESS_TOKEN_TTL_MS } from '../../session-policy';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { EnvironmentService } from '../../../environment/environment.service';
import { derivePurposeKey, parseKeyringEnvVar } from '../../../secret-encryption/keyring.util';

/**
 * `sub`/`org`/`roles`/`sid` only — permissions are never embedded (resolved
 * server-side per request, rab-workforce-architecture.md §5.2), so a
 * revoked permission takes effect immediately rather than waiting out a
 * 15-minute token TTL.
 */
export interface AccessTokenPayload {
  sub: string;
  org: string;
  roles: string[];
  sid: string;
  applicationTarget?: ApplicationTarget;
}

/**
 * PHASE 10 — explicit JWT hardening. `sign`/`verify` previously left
 * algorithm/issuer/audience entirely to `jsonwebtoken`'s own defaults
 * (whatever HMAC variant it infers from a plain string secret, no issuer/
 * audience check at all). Pinning all three here means a token can never be
 * accepted under an unexpected algorithm (the classic RS256/HS256 confusion
 * class of attack, even though this deployment only ever uses one symmetric
 * secret today) or with a signature that happens to verify against this
 * secret but was never actually minted as one of THIS service's own access
 * tokens (e.g. a QR token, which is HS256-signed with a DIFFERENT, HKDF-
 * derived secret and its own issuer/audience — see QrTokenService).
 */
const ALGORITHM = 'HS256' as const;
const ISSUER = 'rab-auth';
const AUDIENCE = 'rab-api';
const LEGACY_KID = 'legacy';

/**
 * Wave 2 lane A2 (key separation). Kids in the verify map:
 *   - APP_JWT_SIGNING_KEYRING entries: dedicated secrets, used directly as the HS256 key exactly as in Checkpoint 3, so a
 *     token already issued under an existing kid keeps verifying. Boot validation refuses a keyring secret shared with
 *     APP_SECRET, the encryption keyring or the cache MAC key (keyring.util.ts `keyMaterialProblems`).
 *   - `derived-v1`: HKDF-SHA256(APP_SECRET, info "crewflow:key-purpose:v1:jwt-access:derived-v1"). The SIGNING key when
 *     no keyring is configured (the documented dev/default derivation), so raw APP_SECRET is no longer used to sign.
 *   - `legacy`: raw APP_SECRET. Verify-only, for tokens signed before this change (`kid: "legacy"` or no kid).
 * APP_JWT_LEGACY_VERIFY_ENABLED=false removes every APP_SECRET-rooted kid that is not the signing key: `legacy` always,
 * and `derived-v1` too once a dedicated keyring is active. With a keyring and the flag off, APP_SECRET is no longer a JWT
 * key in any role. Never two secrets for one kid; a kid absent from the map is an unknown kid (rejected).
 * Rotation: WAVE2_LANE_A2_REPORT.md §3 (add the new kid verify-only everywhere, flip APP_JWT_ACTIVE_KID, wait one access
 * TTL, remove the old kid). ES256/JWKS stays deferred (no external verifiers).
 */
export const LEGACY_JWT_KID = LEGACY_KID;
export const DERIVED_JWT_KID = 'derived-v1';
const RESERVED_KIDS = new Set([LEGACY_KID, DERIVED_JWT_KID]);

@Injectable()
export class AccessTokenService {
  private readonly keyring: Map<string, string | Buffer>;
  private readonly activeKid: string;
  /** Wave 1 lane A (B2) / wave 2 lane A2: see the class comment. Default true — unchanged verification behaviour. */
  private readonly legacyVerifyEnabled: boolean;

  constructor(
    private readonly jwt: JwtService,
    env: EnvironmentService,
  ) {
    this.legacyVerifyEnabled = env.get('APP_JWT_LEGACY_VERIFY_ENABLED') !== false;
    const appSecret = env.get('APP_SECRET');
    this.keyring = new Map<string, string | Buffer>([
      [LEGACY_KID, appSecret],
      [DERIVED_JWT_KID, derivePurposeKey(appSecret, 'jwt-access', DERIVED_JWT_KID)],
    ]);

    const rawKeyring = env.get('APP_JWT_SIGNING_KEYRING');
    if (rawKeyring) {
      for (const entry of parseKeyringEnvVar(rawKeyring, 'APP_JWT_SIGNING_KEYRING')) {
        if (RESERVED_KIDS.has(entry.kid)) {
          throw new Error(
            `APP_JWT_SIGNING_KEYRING must not define a key with kid "${entry.kid}" — that kid is reserved for the implicit APP_SECRET-rooted keys (legacy, derived-v1).`,
          );
        }
        this.keyring.set(entry.kid, entry.secret);
      }

      const activeKid = env.get('APP_JWT_ACTIVE_KID');
      if (!activeKid) {
        throw new Error('APP_JWT_ACTIVE_KID is required when APP_JWT_SIGNING_KEYRING is set — refusing to guess which key is active.');
      }
      if (!this.keyring.has(activeKid) || RESERVED_KIDS.has(activeKid)) {
        throw new Error(`APP_JWT_ACTIVE_KID "${activeKid}" is not present in APP_JWT_SIGNING_KEYRING.`);
      }
      this.activeKid = activeKid;
    } else {
      this.activeKid = DERIVED_JWT_KID;
    }

    if (!this.legacyVerifyEnabled) {
      // Removed from the verify map entirely (not merely skipped), so neither an explicit `kid: "legacy"` nor a kid-less
      // token can ever select raw APP_SECRET as a verification key.
      this.keyring.delete(LEGACY_KID);
      if (this.activeKid !== DERIVED_JWT_KID) this.keyring.delete(DERIVED_JWT_KID);
    }
  }

  /**
   * `clampToMs`, when given, caps this token's own TTL so it can never
   * outlive the session family's absolute deadline (Phase 10 §16) — e.g. a
   * web session with 3 minutes left before its 24h ceiling must never
   * receive a fresh 15-minute token. Callers pass `familyExpiresAt.getTime()
   * - Date.now()`; a value at or below zero collapses to a token that is
   * already expired, matching "no bearer access survives past the deadline."
   */
  sign(payload: AccessTokenPayload, clampToMs?: number): string {
    const ttlMs = clampToMs === undefined ? ACCESS_TOKEN_TTL_MS : Math.max(0, Math.min(ACCESS_TOKEN_TTL_MS, clampToMs));
    // jsonwebtoken's `expiresIn` takes a plain number as SECONDS — rounded
    // down so a clamp never rounds UP past the family deadline it's meant
    // to enforce (a fractional second of extra validity is the wrong
    // direction to round a security boundary).
    const ttlSeconds = Math.floor(ttlMs / 1000);
    const secret = this.keyring.get(this.activeKid)!;
    return this.jwt.sign(
      { ...payload, applicationTarget: payload.applicationTarget ?? defaultApplication(payload.roles) },
      { secret, expiresIn: ttlSeconds, algorithm: ALGORITHM, issuer: ISSUER, audience: AUDIENCE, keyid: this.activeKid },
    );
  }

  verify(token: string): AccessTokenPayload {
    const kid = this.extractKid(token);
    const secret = this.keyring.get(kid);
    if (!secret) {
      throw new Error(`Cannot verify: unknown signing key id "${kid}".`);
    }
    return this.jwt.verify<AccessTokenPayload>(token, { secret, algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE });
  }

  /**
   * Reads `kid` from the UNVERIFIED header to select which secret to verify against — this is a
   * lookup key, not a trust decision; the actual signature/issuer/audience/algorithm/expiry checks
   * all still happen in `verify()` above against whichever secret this resolves to. A token with no
   * `kid` header (every token issued before this keyring existed) resolves to `legacy`. A malformed
   * token that cannot even be decoded fails here, closed, rather than falling through to `verify()`
   * with `kid: undefined` defaulting to something decodable.
   */
  private extractKid(token: string): string {
    let decoded: ReturnType<JwtService['decode']>;
    try {
      decoded = this.jwt.decode(token, { complete: true });
    } catch {
      throw new Error('Cannot verify: malformed token.');
    }
    if (!decoded || typeof decoded !== 'object' || !('header' in decoded)) {
      throw new Error('Cannot verify: malformed token.');
    }
    const kid = (decoded.header as { kid?: unknown }).kid;
    if (kid === undefined) {
      // With legacy verification off, `legacy` is absent from the keyring, so `verify()` rejects this as an unknown kid.
      return LEGACY_KID;
    }
    if (typeof kid !== 'string') {
      throw new Error('Cannot verify: malformed token (non-string kid).');
    }
    return kid;
  }

  /**
   * P2.4 — never returns the signing secret itself, only the operator-chosen `kid` labels. Lets
   * `secret:rotate --check-keyring` report which kid this process signs new access tokens with
   * and which kids it can still verify — see `SecretEncryptionService.getKeyringSummary()`'s own
   * doc comment for the rollout runbook this supports.
   */
  getKeyringSummary(): { activeKid: string; kids: string[] } {
    return { activeKid: this.activeKid, kids: [...this.keyring.keys()] };
  }
}
