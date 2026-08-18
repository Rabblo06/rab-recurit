import { PasswordHashingService } from './password-hashing.service';

describe('PasswordHashingService', () => {
  const service = new PasswordHashingService();

  it('produces an argon2id hash', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('verifies a matching password', async () => {
    const hash = await service.hash('correct horse battery staple');
    await expect(service.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hash('correct horse battery staple');
    await expect(service.verify(hash, 'wrong password')).resolves.toBe(false);
  });

  it('salts each hash independently — same password, different hash', async () => {
    const [a, b] = await Promise.all([
      service.hash('correct horse battery staple'),
      service.hash('correct horse battery staple'),
    ]);
    expect(a).not.toBe(b);
  });
});
