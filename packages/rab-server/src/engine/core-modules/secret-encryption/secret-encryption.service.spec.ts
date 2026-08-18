import { EnvironmentService } from '../environment/environment.service';
import { SecretEncryptionService } from './secret-encryption.service';

function buildService(appSecret = 'a'.repeat(32)): SecretEncryptionService {
  const env = { get: jest.fn().mockReturnValue(appSecret) } as unknown as EnvironmentService;
  return new SecretEncryptionService(env);
}

describe('SecretEncryptionService', () => {
  it('round-trips a plaintext value', () => {
    const service = buildService();
    const encrypted = service.encrypt('12-34-56 12345678');
    expect(service.decrypt(encrypted)).toBe('12-34-56 12345678');
  });

  it('produces different ciphertext for the same plaintext each time (random IV)', () => {
    const service = buildService();
    const a = service.encrypt('secret');
    const b = service.encrypt('secret');
    expect(a.equals(b)).toBe(false);
    expect(service.decrypt(a)).toBe('secret');
    expect(service.decrypt(b)).toBe('secret');
  });

  it('masks all but the last few characters', () => {
    const service = buildService();
    const encrypted = service.encrypt('12345678');
    expect(service.decryptAndMask(encrypted)).toBe('••••5678');
  });

  it('rejects tampered ciphertext (authenticated encryption)', () => {
    const service = buildService();
    const encrypted = service.encrypt('secret');
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => service.decrypt(encrypted)).toThrow();
  });

  it('cannot decrypt data encrypted under a different APP_SECRET', () => {
    const serviceA = buildService('a'.repeat(32));
    const serviceB = buildService('b'.repeat(32));
    const encrypted = serviceA.encrypt('secret');
    expect(() => serviceB.decrypt(encrypted)).toThrow();
  });
});
