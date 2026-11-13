import { PasswordHashingService } from './password-hashing.service';
import { argon2Parameters } from '../../../../__tests__/helpers/argon2-parameters';

describe('PasswordHashingService', () => {
  const service = new PasswordHashingService();

  it('produces an argon2id hash', async () => {
    const hash = await service.hash('hashing unit sample passphrase');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  // XA-10 (Phase X2, X6.3b): the CLAUDE.md floor, read back from the ACTUAL encoded hash rather than from the options
  // object, so a weaker option, a library default change or a different hashing call is caught where it matters.
  it('encodes argon2id v=19 with m >= 19456 KiB, t >= 2, p = 1 (the CLAUDE.md floor), read from the actual hash', async () => {
    const params = argon2Parameters(await service.hash('hashing unit sample passphrase'));
    expect(params.variant).toBe('argon2id');
    expect(params.version).toBe(19);
    expect(params.memoryKiB).toBeGreaterThanOrEqual(19456);
    expect(params.iterations).toBeGreaterThanOrEqual(2);
    expect(params.parallelism).toBe(1);
    // A 16-byte salt and a 32-byte tag at minimum (base64 without padding: 22 and 43 characters).
    expect(params.saltB64.length).toBeGreaterThanOrEqual(22);
    expect(params.hashB64.length).toBeGreaterThanOrEqual(43);
  });

  it('the parameter reader refuses anything that is not a PHC-encoded argon2 string (fails closed, never a default)', () => {
    expect(() => argon2Parameters('$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234')).toThrow();
    expect(() => argon2Parameters('$argon2id$v=19$m=19456,t=2$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA')).toThrow();
    expect(() => argon2Parameters('')).toThrow();
  });

  it('verifies a matching password', async () => {
    const hash = await service.hash('hashing unit sample passphrase');
    await expect(service.verify(hash, 'hashing unit sample passphrase')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hash('hashing unit sample passphrase');
    await expect(service.verify(hash, 'wrong password')).resolves.toBe(false);
  });

  it('salts each hash independently — same password, different hash', async () => {
    const [a, b] = await Promise.all([
      service.hash('hashing unit sample passphrase'),
      service.hash('hashing unit sample passphrase'),
    ]);
    expect(a).not.toBe(b);
  });
});
