import { EnvironmentVariables } from './environment-variables';
import { productionConfigurationProblems, validate } from './env.validation';

const SECURE: Partial<EnvironmentVariables> = {
  NODE_ENV: 'production',
  EMAIL_DRIVER: 'SMTP',
  STORAGE_DRIVER: 'S3',
  PUSH_ENABLED: false,
  PUSH_PROVIDER: 'FAKE',
  APP_URL: 'https://app.example.com',
  ACCOUNTS_URL: 'https://accounts.example.com',
  CORS_ORIGINS: 'https://app.example.com,https://accounts.example.com',
  TRUSTED_PROXY_CIDRS: '10.0.12.7/32,2001:db8::1',
};
const problems = (over: Partial<EnvironmentVariables>) => productionConfigurationProblems({ ...SECURE, ...over } as EnvironmentVariables);

describe('production configuration refusals (CF-40, CF-16, CF-34)', () => {
  it('a correctly configured production environment has no problems', () => {
    expect(problems({})).toEqual([]);
  });

  it.each([
    ['EMAIL_DRIVER=LOGGER (CF-34)', { EMAIL_DRIVER: 'LOGGER' }, /EMAIL_DRIVER/],
    ['STORAGE_DRIVER=LOCAL', { STORAGE_DRIVER: 'LOCAL' }, /STORAGE_DRIVER/],
    ['fake push while push is on', { PUSH_ENABLED: true, PUSH_PROVIDER: 'FAKE' }, /PUSH_PROVIDER/],
    ['http APP_URL', { APP_URL: 'http://app.example.com' }, /APP_URL/],
    ['localhost ACCOUNTS_URL', { ACCOUNTS_URL: 'https://localhost:5173' }, /ACCOUNTS_URL/],
    ['default CORS_ORIGINS', { CORS_ORIGINS: 'http://localhost:5173' }, /CORS_ORIGINS/],
    ['empty TRUSTED_PROXY_CIDRS (CF-16)', { TRUSTED_PROXY_CIDRS: '' }, /TRUSTED_PROXY_CIDRS is empty/],
    ['0.0.0.0/0', { TRUSTED_PROXY_CIDRS: '0.0.0.0/0' }, /over-broad/],
    ['a whole Docker private range', { TRUSTED_PROXY_CIDRS: '172.16.0.0/12' }, /over-broad/],
    ['::/0', { TRUSTED_PROXY_CIDRS: '::/0' }, /over-broad/],
  ])('refuses %s', (_name, over, pattern) => {
    expect(problems(over as Partial<EnvironmentVariables>).join('\n')).toMatch(pattern);
  });

  it('development keeps every local default (local Docker is not broken)', () => {
    expect(() => validate({ NODE_ENV: 'development', APP_SECRET: 'x'.repeat(64), DATABASE_URL: 'postgres://u:p@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379' })).not.toThrow(/for production/);
  });
});
