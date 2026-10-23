import { createHmac, hkdfSync } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import jwt from 'jsonwebtoken';

import { EnvironmentService } from '../../../environment/environment.service';
import { AccessTokenService } from './access-token.service';

const SECRET = 'a'.repeat(32);

describe('AccessTokenService', () => {
  function buildService(
    secret = SECRET,
    overrides: { APP_JWT_SIGNING_KEYRING?: string; APP_JWT_ACTIVE_KID?: string; APP_JWT_LEGACY_VERIFY_ENABLED?: boolean } = {},
  ): AccessTokenService {
    const values: Record<string, string | boolean | undefined> = {
      APP_SECRET: secret,
      APP_JWT_SIGNING_KEYRING: overrides.APP_JWT_SIGNING_KEYRING,
      APP_JWT_ACTIVE_KID: overrides.APP_JWT_ACTIVE_KID,
      APP_JWT_LEGACY_VERIFY_ENABLED: overrides.APP_JWT_LEGACY_VERIFY_ENABLED,
    };
    const env = { get: jest.fn((key: string) => values[key]) } as unknown as EnvironmentService;
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

  // ---------------------------------------------------------------------------------------------- Checkpoint 3 signing-key rotation
  describe('signing-key identifiers and rotation (Checkpoint 3)', () => {
    const payload = { sub: 'user-1', org: 'org-1', roles: ['staff'], sid: 'sid-1' };
    const rotatedSecret = 'r'.repeat(32);
    const keyring = JSON.stringify([{ kid: '2026-11', secret: rotatedSecret }]);

    it('a token signed with no keyring configured carries kid="derived-v1" (wave 2: never raw APP_SECRET)', () => {
      const service = buildService();
      const token = service.sign(payload);
      const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      expect(header.kid).toBe('derived-v1');
    });

    it('a pre-existing token with NO kid header at all (issued before this keyring existed) still verifies', () => {
      const service = buildService();
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(
        JSON.stringify({ ...payload, iss: 'rab-auth', aud: 'rab-api', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 }),
      ).toString('base64url');
      const signature = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
      const kidLessToken = `${header}.${body}.${signature}`;
      expect(service.verify(kidLessToken)).toMatchObject(payload);
    });

    it('new sign() calls use the configured active kid, and the resulting token verifies', () => {
      const service = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: keyring, APP_JWT_ACTIVE_KID: '2026-11' });
      const token = service.sign(payload);
      const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      expect(header.kid).toBe('2026-11');
      expect(service.verify(token)).toMatchObject(payload);
    });

    it('a token signed under a previous active kid remains verifiable after the active kid rotates again', () => {
      const serviceV1 = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: keyring, APP_JWT_ACTIVE_KID: '2026-11' });
      const oldToken = serviceV1.sign(payload);

      const thirdSecret = 't'.repeat(32);
      const widerKeyring = JSON.stringify([
        { kid: '2026-11', secret: rotatedSecret },
        { kid: '2026-12', secret: thirdSecret },
      ]);
      const serviceV2 = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: widerKeyring, APP_JWT_ACTIVE_KID: '2026-12' });

      expect(serviceV2.verify(oldToken)).toMatchObject(payload);
      const newToken = serviceV2.sign(payload);
      expect(serviceV2.verify(newToken)).toMatchObject(payload);
    });

    it('rejects a token carrying an unknown kid, even with a mathematically valid signature for that (unreachable) key', () => {
      const service = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: keyring, APP_JWT_ACTIVE_KID: '2026-11' });
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'nonexistent-kid' })).toString('base64url');
      const body = Buffer.from(
        JSON.stringify({ ...payload, iss: 'rab-auth', aud: 'rab-api', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 }),
      ).toString('base64url');
      const forged = `${header}.${body}.fake-signature`;
      expect(() => service.verify(forged)).toThrow(/unknown signing key id/);
    });

    it('algorithm confusion is still rejected even for a non-legacy kid (Phase 10 hardening carries over per-key)', () => {
      const service = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: keyring, APP_JWT_ACTIVE_KID: '2026-11' });
      const token = jwt.sign(payload, rotatedSecret, { algorithm: 'HS384', issuer: 'rab-auth', audience: 'rab-api', expiresIn: '15m', keyid: '2026-11' });
      expect(() => service.verify(token)).toThrow();
    });

    it('fails closed at construction if APP_JWT_SIGNING_KEYRING is set without APP_JWT_ACTIVE_KID', () => {
      expect(() => buildService(SECRET, { APP_JWT_SIGNING_KEYRING: keyring })).toThrow(/APP_JWT_ACTIVE_KID is required/);
    });

    it('fails closed at construction if APP_JWT_ACTIVE_KID does not exist in the keyring', () => {
      expect(() => buildService(SECRET, { APP_JWT_SIGNING_KEYRING: keyring, APP_JWT_ACTIVE_KID: 'nonexistent' })).toThrow(
        /not present in APP_JWT_SIGNING_KEYRING/,
      );
    });

    it('rejects a keyring entry that reuses the reserved "legacy" kid', () => {
      const reservedKeyring = JSON.stringify([{ kid: 'legacy', secret: rotatedSecret }]);
      expect(() => buildService(SECRET, { APP_JWT_SIGNING_KEYRING: reservedKeyring, APP_JWT_ACTIVE_KID: 'legacy' })).toThrow(
        /reserved for the implicit/,
      );
    });
  });

  // ---------------------------------------------------------------------------------------------- Wave 1 lane A (B2)
  describe('APP_JWT_LEGACY_VERIFY_ENABLED (legacy APP_SECRET key cut-off)', () => {
    const payload = { sub: 'user-1', org: 'org-1', roles: ['staff'], sid: 'sid-1' };
    const rotatedSecret = 'r'.repeat(32);
    const keyring = JSON.stringify([{ kid: '2026-11', secret: rotatedSecret }]);
    const now = () => Math.floor(Date.now() / 1000);
    const handSigned = (header: Record<string, unknown>, secret: string, expOffset = 900) => {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...header })).toString('base64url');
      const b = Buffer.from(JSON.stringify({ ...payload, iss: 'rab-auth', aud: 'rab-api', iat: now(), exp: now() + expOffset })).toString('base64url');
      return `${h}.${b}.${createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url')}`;
    };
    const legacyOff = () => buildService(SECRET, { APP_JWT_SIGNING_KEYRING: keyring, APP_JWT_ACTIVE_KID: '2026-11', APP_JWT_LEGACY_VERIFY_ENABLED: false });

    it('default (flag unset): a legacy-signed token still verifies alongside a keyring (unchanged behaviour)', () => {
      const legacy = buildService().sign(payload);
      const service = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: keyring, APP_JWT_ACTIVE_KID: '2026-11' });
      expect(service.verify(legacy)).toMatchObject(payload);
      expect(service.getKeyringSummary().kids).toContain('legacy');
    });

    it('flag off: a valid token signed with the active keyring key verifies', () => {
      const service = legacyOff();
      expect(service.verify(service.sign(payload))).toMatchObject(payload);
    });

    it('flag off: a token signed with APP_SECRET under kid "legacy" is rejected', () => {
      expect(() => legacyOff().verify(handSigned({ kid: 'legacy' }, SECRET))).toThrow(/unknown signing key id "legacy"/);
    });

    it('flag off: a kid-less APP_SECRET-signed token is rejected', () => {
      expect(() => legacyOff().verify(handSigned({}, SECRET))).toThrow(/unknown signing key id/);
    });

    it('flag off: a kid-less token signed with the ACTIVE keyring secret is also rejected (no kid ⇒ legacy, which is gone)', () => {
      expect(() => legacyOff().verify(handSigned({}, rotatedSecret))).toThrow(/unknown signing key id/);
    });

    it('flag off: an expired token under the active kid is still rejected', () => {
      expect(() => legacyOff().verify(handSigned({ kid: '2026-11' }, rotatedSecret, -10))).toThrow();
    });

    it('flag off: "legacy" is no longer in the verify keyring summary', () => {
      expect(legacyOff().getKeyringSummary()).toEqual({ activeKid: '2026-11', kids: ['2026-11'] });
    });

    it('flag off without a keyring (wave 2): signs and verifies derived-v1, rejects raw-APP_SECRET tokens', () => {
      const service = buildService(SECRET, { APP_JWT_LEGACY_VERIFY_ENABLED: false });
      expect(service.verify(service.sign(payload))).toMatchObject(payload);
      expect(() => service.verify(handSigned({ kid: 'legacy' }, SECRET))).toThrow(/unknown signing key id "legacy"/);
      expect(() => service.verify(handSigned({}, SECRET))).toThrow(/unknown signing key id "legacy"/);
      expect(service.getKeyringSummary()).toEqual({ activeKid: 'derived-v1', kids: ['derived-v1'] });
    });

    it('flag off with a keyring: the APP_SECRET-derived default kid is gone too (APP_SECRET is no JWT key at all)', () => {
      const derived = buildService().sign(payload);
      expect(() => legacyOff().verify(derived)).toThrow(/unknown signing key id "derived-v1"/);
    });
  });

  // ---------------------------------------------------------------------------------------------- Wave 2 lane A2
  describe('key separation: derived default kid and rotation without abrupt invalidation', () => {
    const payload = { sub: 'user-1', org: 'org-1', roles: ['staff'], sid: 'sid-1' };
    const secretA = 'Zk3q8LmW1xT0vB7nR5cY2pH9dF4sJ6gA';
    const secretB = 'p9Qw2Er7Ty1Ui8Op3As6Df0Gh5Jk4LzX';
    const now = () => Math.floor(Date.now() / 1000);
    const handSigned = (header: Record<string, unknown>, secret: string | Buffer, expOffset = 900) => {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...header })).toString('base64url');
      const b = Buffer.from(JSON.stringify({ ...payload, iss: 'rab-auth', aud: 'rab-api', iat: now(), exp: now() + expOffset })).toString('base64url');
      return `${h}.${b}.${createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url')}`;
    };

    it('the derived-v1 signing key is HKDF(APP_SECRET, purpose label), not APP_SECRET itself', () => {
      const derivedKey = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET, 'utf8'), Buffer.alloc(0), 'crewflow:key-purpose:v1:jwt-access:derived-v1', 32));
      const service = buildService();
      expect(service.verify(handSigned({ kid: 'derived-v1' }, derivedKey))).toMatchObject(payload);
      // A token claiming derived-v1 but signed with raw APP_SECRET is a forgery.
      expect(() => service.verify(handSigned({ kid: 'derived-v1' }, SECRET))).toThrow();
    });

    it('tokens minted before wave 2 (kid "legacy" and kid-less, raw APP_SECRET) keep verifying by default (no abrupt invalidation)', () => {
      const service = buildService();
      expect(service.verify(handSigned({ kid: 'legacy' }, SECRET))).toMatchObject(payload);
      expect(service.verify(handSigned({}, SECRET))).toMatchObject(payload);
    });

    it('expired tokens are rejected under every kid', () => {
      const derivedKey = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET, 'utf8'), Buffer.alloc(0), 'crewflow:key-purpose:v1:jwt-access:derived-v1', 32));
      const service = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'k1', secret: secretA }]), APP_JWT_ACTIVE_KID: 'k1' });
      expect(() => service.verify(handSigned({ kid: 'legacy' }, SECRET, -5))).toThrow(/expired/);
      expect(() => service.verify(handSigned({ kid: 'derived-v1' }, derivedKey, -5))).toThrow(/expired/);
      expect(() => service.verify(handSigned({ kid: 'k1' }, secretA, -5))).toThrow(/expired/);
    });

    it('full rotation derived-v1 → k1 → k2: every token stays valid until its own kid is removed', () => {
      const stage0 = buildService();
      const t0 = stage0.sign(payload); // derived-v1

      // Stage 1: k1 deployed and active; derived-v1 still verifies (legacy flag default on).
      const stage1 = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'k1', secret: secretA }]), APP_JWT_ACTIVE_KID: 'k1' });
      expect(stage1.verify(t0)).toMatchObject(payload);
      const t1 = stage1.sign(payload);

      // Stage 2: k2 added verify-only (active unchanged) — both instances' tokens verify on both stages.
      const ring12 = JSON.stringify([{ kid: 'k1', secret: secretA }, { kid: 'k2', secret: secretB }]);
      const stage2 = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: ring12, APP_JWT_ACTIVE_KID: 'k1' });
      expect(stage2.verify(t1)).toMatchObject(payload);

      // Stage 3: flip to k2; k1 tokens still verify; an instance still on stage 2 verifies k2 tokens too.
      const stage3 = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: ring12, APP_JWT_ACTIVE_KID: 'k2' });
      const t2 = stage3.sign(payload);
      expect(stage3.verify(t1)).toMatchObject(payload);
      expect(stage2.verify(t2)).toMatchObject(payload);

      // Stage 4 (after one access TTL): k1 retired and APP_SECRET roots switched off.
      const stage4 = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'k2', secret: secretB }]), APP_JWT_ACTIVE_KID: 'k2', APP_JWT_LEGACY_VERIFY_ENABLED: false });
      expect(stage4.verify(t2)).toMatchObject(payload);
      expect(() => stage4.verify(t1)).toThrow(/unknown signing key id "k1"/);
      expect(() => stage4.verify(t0)).toThrow(/unknown signing key id "derived-v1"/);
      expect(stage4.getKeyringSummary()).toEqual({ activeKid: 'k2', kids: ['k2'] });
    });

    it('rejects a keyring entry that reuses the reserved "derived-v1" kid, and an active kid naming an implicit key', () => {
      expect(() => buildService(SECRET, { APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'derived-v1', secret: secretA }]), APP_JWT_ACTIVE_KID: 'derived-v1' })).toThrow(/reserved/);
      expect(() => buildService(SECRET, { APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'k1', secret: secretA }]), APP_JWT_ACTIVE_KID: 'legacy' })).toThrow(/not present in APP_JWT_SIGNING_KEYRING/);
    });

    it('a token for kid k1 signed with the derived default key (cross-kid substitution) is rejected', () => {
      const derivedKey = Buffer.from(hkdfSync('sha256', Buffer.from(SECRET, 'utf8'), Buffer.alloc(0), 'crewflow:key-purpose:v1:jwt-access:derived-v1', 32));
      const service = buildService(SECRET, { APP_JWT_SIGNING_KEYRING: JSON.stringify([{ kid: 'k1', secret: secretA }]), APP_JWT_ACTIVE_KID: 'k1' });
      expect(() => service.verify(handSigned({ kid: 'k1' }, derivedKey))).toThrow();
      expect(() => service.verify(handSigned({ kid: 'k1' }, SECRET))).toThrow();
    });
  });
});
