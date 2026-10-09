import { seedSuccessMessage } from './seed-success-message';

describe('seed success message', () => {
  it('names the organisation and account but never a password value', () => {
    const message = seedSuccessMessage({ slug: 'rab', email: 'owner@rab.test' });
    expect(message).toContain('"rab"');
    expect(message).toContain('owner@rab.test');
    expect(message).toContain('SEED_ADMIN_PASSWORD');
    expect(message).not.toMatch(/password="/);
  });

  it('cannot carry a password: the function accepts only slug and email', () => {
    expect(seedSuccessMessage.length).toBe(1);
    const message = seedSuccessMessage({ slug: 'rab', email: 'owner@rab.test' });
    expect(message).not.toContain('secret-sentinel');
  });
});
