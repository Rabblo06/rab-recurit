import { JwtService } from '@nestjs/jwt';
import jwt from 'jsonwebtoken';

import { EnvironmentService } from '../../../environment/environment.service';
import { AccessTokenService } from './access-token.service';

const SECRET = 'a'.repeat(32);

describe('AccessTokenService', () => {
  function buildService(secret = SECRET): AccessTokenService {
    const env = { get: jest.fn().mockReturnValue(secret) } as unknown as EnvironmentService;
    return new AccessTokenService(new JwtService(), env);
  }

  it('round-trips a payload', () => {
    const service = buildService();
    const payload = { sub: 'user-1', org: 'org-1', roles: ['org_admin'], sid: 'sid-1' };
    const token = service.sign(payload);
    const verified = service.verify(token);
    expect(verified).toMatchObject(payload);
  });

  it('rejects a token signed under a different secret', () => {
    const serviceA = buildService();
    const serviceB = buildService('b'.repeat(32));

    const token = serviceA.sign({ sub: 'user-1', org: 'org-1', roles: [], sid: 'sid-1' });
    expect(() => serviceB.verify(token)).toThrow();
  });

  it('never embeds resolved permissions — only sub/org/roles/sid plus standard JWT claims', () => {
    const service = buildService();
    const token = service.sign({ sub: 'user-1', org: 'org-1', roles: ['staff'], sid: 'sid-1' });
    const decodedPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(Object.keys(decodedPayload).sort()).toEqual(['applicationTarget', 'aud', 'exp', 'iat', 'iss', 'org', 'roles', 'sid', 'sub']);
  });

  // ---------------------------------------------------------------------------------------------- Phase 10 JWT hardening
  describe('algorithm/issuer/audience hardening', () => {
    const payload = { sub: 'user-1', org: 'org-1', roles: ['staff'], sid: 'sid-1' };

    it('54: a genuinely valid token is accepted', () => {
      const service = buildService();
      expect(() => service.verify(service.sign(payload))).not.toThrow();
    });

    it('55: alg=none is rejected', () => {
      const service = buildService();
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ ...payload, iss: 'rab-auth', aud: 'rab-api', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
      const forged = `${header}.${body}.`;
      expect(() => service.verify(forged)).toThrow();
    });

    it('56: a token signed with a different algorithm (HS384) under the SAME secret is rejected', () => {
      const service = buildService();
      const token = jwt.sign(payload, SECRET, { algorithm: 'HS384', issuer: 'rab-auth', audience: 'rab-api', expiresIn: '15m' });
      expect(() => service.verify(token)).toThrow();
    });

    it('57: a token with the wrong issuer is rejected even though the signature is otherwise valid', () => {
      const service = buildService();
      const token = jwt.sign(payload, SECRET, { algorithm: 'HS256', issuer: 'someone-else', audience: 'rab-api', expiresIn: '15m' });
      expect(() => service.verify(token)).toThrow();
    });

    it('58: a token with the wrong audience is rejected even though the signature is otherwise valid', () => {
      const service = buildService();
      const token = jwt.sign(payload, SECRET, { algorithm: 'HS256', issuer: 'rab-auth', audience: 'someone-else', expiresIn: '15m' });
      expect(() => service.verify(token)).toThrow();
    });

    it('59: an expired token is rejected', () => {
      const service = buildService();
      const token = jwt.sign(payload, SECRET, { algorithm: 'HS256', issuer: 'rab-auth', audience: 'rab-api', expiresIn: -1 });
      expect(() => service.verify(token)).toThrow();
    });

    it('60: a malformed token is rejected, not a 500-class crash', () => {
      const service = buildService();
      expect(() => service.verify('not.a.jwt')).toThrow();
      expect(() => service.verify('garbage')).toThrow();
      expect(() => service.verify('')).toThrow();
    });
  });

  // ---------------------------------------------------------------------------------------------- Phase 10 access-token clamping
  describe('session-deadline clamping', () => {
    it('issues the full 15-minute TTL when no clamp is given', () => {
      const service = buildService();
      const token = service.sign({ sub: 'u', org: 'o', roles: [], sid: 's' });
      const decoded = jwt.decode(token) as { iat: number; exp: number };
      expect(decoded.exp - decoded.iat).toBe(15 * 60);
    });

    it('clamps to the remaining family time when that is shorter than 15 minutes', () => {
      const service = buildService();
      const threeMinutesMs = 3 * 60 * 1000;
      const token = service.sign({ sub: 'u', org: 'o', roles: [], sid: 's' }, threeMinutesMs);
      const decoded = jwt.decode(token) as { iat: number; exp: number };
      expect(decoded.exp - decoded.iat).toBe(3 * 60);
    });

    it('never issues MORE than the configured 15-minute ceiling even if given a larger clamp', () => {
      const service = buildService();
      const token = service.sign({ sub: 'u', org: 'o', roles: [], sid: 's' }, 999 * 24 * 60 * 60 * 1000);
      const decoded = jwt.decode(token) as { iat: number; exp: number };
      expect(decoded.exp - decoded.iat).toBe(15 * 60);
    });

    it('a clamp of zero or negative (deadline already passed) issues an already-expired token', () => {
      const service = buildService();
      const token = service.sign({ sub: 'u', org: 'o', roles: [], sid: 's' }, -1000);
      expect(() => service.verify(token)).toThrow();
    });
  });
});
