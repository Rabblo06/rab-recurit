import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { validate } from './env.validation';
import { EnvironmentVariables } from './environment-variables';
import { hwsRuntimeDefault, resolveHwsRuntimeEnabled } from './hws-runtime-default';

/**
 * Part C1 (OWNER-DB-ULTIMATE.md Part C, HWS-AUDIT.md §5.1): HWS_RUNTIME_ENABLED is ON when unset, except in production,
 * where unset means OFF (production must not route to the workspace schemas before the C3 cutover). "true"/"false" keep
 * working; any other value refuses to boot.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

/**
 * The class layer exactly as validate() runs it (same options), restricted to this property. Used for production, where the
 * full validate() also needs a complete production configuration that has nothing to do with this rule.
 */
function classLayer(env: Record<string, unknown>): { value: unknown; errors: string[] } {
  const instance = plainToInstance(EnvironmentVariables, env, { enableImplicitConversion: true });
  const errors = validateSync(instance, { skipMissingProperties: false })
    .filter((e) => e.property === 'HWS_RUNTIME_ENABLED')
    .flatMap((e) => Object.values(e.constraints ?? {}));
  return { value: instance.HWS_RUNTIME_ENABLED, errors };
}

describe('HWS_RUNTIME_ENABLED default (Part C1)', () => {
  it('unset + NODE_ENV unset (= development) → on', () => {
    expect(validate({ ...base }).HWS_RUNTIME_ENABLED).toBe(true);
  });

  it('unset + development → on', () => {
    expect(validate({ ...base, NODE_ENV: 'development' }).HWS_RUNTIME_ENABLED).toBe(true);
  });

  it('unset + test → on', () => {
    expect(validate({ ...base, NODE_ENV: 'test' }).HWS_RUNTIME_ENABLED).toBe(true);
  });

  it('empty (KEY= in a .env file) behaves as unset', () => {
    expect(validate({ ...base, NODE_ENV: 'test', HWS_RUNTIME_ENABLED: '' }).HWS_RUNTIME_ENABLED).toBe(true);
  });

  it('unset + production → OFF (fail safe before the C3 cutover)', () => {
    expect(classLayer({ ...base, NODE_ENV: 'production' })).toEqual({ value: false, errors: [] });
  });

  it('a key present with the value undefined is still "unset", never silently false (the class-transformer trap)', () => {
    // `@Transform(({ value }) => value === 'true')` would turn a present-but-undefined key into false and defeat the default.
    expect(classLayer({ ...base, NODE_ENV: 'test', HWS_RUNTIME_ENABLED: undefined })).toEqual({ value: true, errors: [] });
    expect(classLayer({ ...base, NODE_ENV: 'production', HWS_RUNTIME_ENABLED: undefined })).toEqual({ value: false, errors: [] });
  });

  it.each(['development', 'test', 'production'])('explicit "false" → off (NODE_ENV=%s)', (nodeEnv) => {
    expect(classLayer({ ...base, NODE_ENV: nodeEnv, HWS_RUNTIME_ENABLED: 'false' })).toEqual({ value: false, errors: [] });
  });

  it.each(['development', 'test', 'production'])('explicit "true" → on (NODE_ENV=%s)', (nodeEnv) => {
    expect(classLayer({ ...base, NODE_ENV: nodeEnv, HWS_RUNTIME_ENABLED: 'true' })).toEqual({ value: true, errors: [] });
  });

  it('validate(): "false" and "true" outside production', () => {
    expect(validate({ ...base, NODE_ENV: 'test', HWS_RUNTIME_ENABLED: 'false' }).HWS_RUNTIME_ENABLED).toBe(false);
    expect(validate({ ...base, NODE_ENV: 'test', HWS_RUNTIME_ENABLED: 'true' }).HWS_RUNTIME_ENABLED).toBe(true);
  });

  it.each(['yes', 'no', '1', '0', 'TRUE', 'False', 'on', ' true', 'ture'])('refuses to boot with HWS_RUNTIME_ENABLED=%p', (value) => {
    expect(() => validate({ ...base, NODE_ENV: 'test', HWS_RUNTIME_ENABLED: value })).toThrow(/HWS_RUNTIME_ENABLED must be exactly true or false/);
    expect(classLayer({ ...base, NODE_ENV: 'production', HWS_RUNTIME_ENABLED: value }).errors).toHaveLength(1);
  });

  it('the shared rule: unset → on only for development / test / NODE_ENV unset; every other NODE_ENV → off', () => {
    for (const nodeEnv of [undefined, '', 'development', 'test']) expect(hwsRuntimeDefault(nodeEnv)).toBe(true);
    for (const nodeEnv of ['production', 'staging', 'Production', 'prod']) expect(hwsRuntimeDefault(nodeEnv)).toBe(false);
    expect(resolveHwsRuntimeEnabled(undefined, 'production')).toBe(false);
    expect(resolveHwsRuntimeEnabled('', 'test')).toBe(true);
    expect(resolveHwsRuntimeEnabled('true', 'production')).toBe(true);
    expect(resolveHwsRuntimeEnabled('false', 'development')).toBe(false);
    expect(resolveHwsRuntimeEnabled('yes', 'development')).toBe('yes'); // left raw: @IsBoolean refuses it
  });
});
