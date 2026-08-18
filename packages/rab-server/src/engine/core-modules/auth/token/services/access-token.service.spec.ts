import { JwtService } from '@nestjs/jwt';

import { EnvironmentService } from '../../../environment/environment.service';
import { AccessTokenService } from './access-token.service';

describe('AccessTokenService', () => {
  function buildService(): AccessTokenService {
    const env = { get: jest.fn().mockReturnValue('a'.repeat(32)) } as unknown as EnvironmentService;
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
    const env = { get: jest.fn().mockReturnValue('b'.repeat(32)) } as unknown as EnvironmentService;
    const serviceB = new AccessTokenService(new JwtService(), env);

    const token = serviceA.sign({ sub: 'user-1', org: 'org-1', roles: [], sid: 'sid-1' });
    expect(() => serviceB.verify(token)).toThrow();
  });

  it('never embeds resolved permissions — only sub/org/roles/sid', () => {
    const service = buildService();
    const token = service.sign({ sub: 'user-1', org: 'org-1', roles: ['staff'], sid: 'sid-1' });
    const decodedPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(Object.keys(decodedPayload).sort()).toEqual(['exp', 'iat', 'org', 'roles', 'sid', 'sub']);
  });
});
