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
}

const ACCESS_TOKEN_TTL = '15m';

@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly env: EnvironmentService,
  ) {}

  sign(payload: AccessTokenPayload): string {
    return this.jwt.sign(payload, { secret: this.env.get('APP_SECRET'), expiresIn: ACCESS_TOKEN_TTL });
  }

  verify(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token, { secret: this.env.get('APP_SECRET') });
  }
}
