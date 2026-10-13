import { ApplicationTarget, defaultApplication } from '../../application-access';
import { ACCESS_TOKEN_TTL_MS } from '../../session-policy';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { EnvironmentService } from '../../../environment/environment.service';

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
 * Checkpoint 3 — JWT signing-key identifiers and rotation. Deliberately a SEPARATE keyring/env-var
 * pair from SecretEncryptionService's (APP_ENCRYPTION_KEYRING) — a signing key compromised in one
 * role must never also be live in the other, and rotating one must never require touching the
 * other. With no APP_JWT_SIGNING_KEYRING configured, the only key is `legacy` = raw APP_SECRET
 * (NOT HKDF-derived) — this must match exactly what every already-issued, kid-less token was
 * signed with, or every live session's access token would fail verification the moment this ships.
 */
@Injectable()
export class AccessTokenService {
  private readonly keyring: Map<string, string>;
  private readonly activeKid: string;

  constructor(
    private readonly jwt: JwtService,
    env: EnvironmentService,
  ) {
    this.keyring = new Map<string, string>([[LEGACY_KID, env.get('APP_SECRET')]]);

    const rawKeyring = env.get('APP_JWT_SIGNING_KEYRING');
    if (rawKeyring) {
      for (const entry of parseKeyringEnvVar(rawKeyring, 'APP_JWT_SIGNING_KEYRING')) {
        if (entry.kid === LEGACY_KID) {
          throw new Error(
            `APP_JWT_SIGNING_KEYRING must not define a key with kid "${LEGACY_KID}" — that kid is reserved for the implicit APP_SECRET-derived key.`,
          );
        }
        this.keyring.set(entry.kid, entry.secret);
      }

      const activeKid = env.get('APP_JWT_ACTIVE_KID');
      if (!activeKid) {
        throw new Error('APP_JWT_ACTIVE_KID is required when APP_JWT_SIGNING_KEYRING is set — refusing to guess which key is active.');
      }
      if (!this.keyring.has(activeKid)) {
        throw new Error(`APP_JWT_ACTIVE_KID "${activeKid}" is not present in APP_JWT_SIGNING_KEYRING.`);
      }
      this.activeKid = activeKid;
    } else {
      this.activeKid = LEGACY_KID;
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

function parseKeyringEnvVar(raw: string, varName: string): Array<{ kid: string; secret: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${varName} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${varName} must be a JSON array.`);
  }
  return parsed.map((entry, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { kid?: unknown }).kid !== 'string' ||
      typeof (entry as { secret?: unknown }).secret !== 'string'
    ) {
      throw new Error(`${varName}[${index}] must be an object with string "kid" and "secret" fields.`);
    }
    const { kid, secret } = entry as { kid: string; secret: string };
    if (!kid) {
      throw new Error(`${varName}[${index}].kid must not be empty.`);
    }
    if (secret.length < 32) {
      throw new Error(`${varName}[${index}].secret ("${kid}") must be at least 32 characters.`);
    }
    return { kid, secret };
  });
}
