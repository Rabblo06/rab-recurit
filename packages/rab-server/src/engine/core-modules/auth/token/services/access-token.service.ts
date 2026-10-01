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

@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly env: EnvironmentService,
  ) {}

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
    return this.jwt.sign(
      { ...payload, applicationTarget: payload.applicationTarget ?? defaultApplication(payload.roles) },
      { secret: this.env.get('APP_SECRET'), expiresIn: ttlSeconds, algorithm: ALGORITHM, issuer: ISSUER, audience: AUDIENCE },
    );
  }

  verify(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token, { secret: this.env.get('APP_SECRET'), algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE });
  }
}
