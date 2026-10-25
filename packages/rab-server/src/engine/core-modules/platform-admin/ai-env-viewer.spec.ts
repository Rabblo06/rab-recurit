import * as fs from 'fs';
import * as path from 'path';

import { ANTHROPIC_API_KEY_ENV, DEPRECATED_AI_PROVIDER_API_KEY_ENV } from '../ai/models/provider-keys';
import { EnvironmentVariables } from '../environment/environment-variables';
import { ENVIRONMENT_ALLOWLIST, environmentRows } from './admin-config.service';

/**
 * Owner decision 2 / security 4.3 + 12.3: the admin environment viewer shows provider keys as "configured" only. Canary:
 * a recognisable fake value is configured and must not appear anywhere in what the viewer returns.
 */
describe('admin environment viewer: AI provider keys are secret-classed (canary)', () => {
  const CANARY = 'sk-ant-api03-CANARY-'.padEnd(64, 'Q');

  it('ANTHROPIC_API_KEY and the deprecated alias are listed as secret', () => {
    for (const key of [ANTHROPIC_API_KEY_ENV, DEPRECATED_AI_PROVIDER_API_KEY_ENV]) {
      expect(ENVIRONMENT_ALLOWLIST.find((e) => e.key === key)).toEqual({ group: 'AI providers', key, kind: 'secret' });
    }
  });

  it('a configured key is reported as "set" with no value, prefix or length — the canary appears nowhere', () => {
    const values: Partial<Record<keyof EnvironmentVariables, unknown>> = {
      [ANTHROPIC_API_KEY_ENV]: CANARY,
      [DEPRECATED_AI_PROVIDER_API_KEY_ENV]: `${CANARY}-alias`,
      AI_MODEL: 'anthropic-claude-haiku-5-5',
      AI_DAILY_BUDGET_USD: 2,
      AI_DEV_ALLOW_REAL_PROVIDERS: true,
    };
    const rows = environmentRows((key) => values[key]);
    expect(JSON.stringify(rows)).not.toContain('CANARY');
    expect(rows.find((r) => r.key === ANTHROPIC_API_KEY_ENV)).toEqual({ group: 'AI providers', key: ANTHROPIC_API_KEY_ENV, state: 'set', value: null, source: 'env (secret)' });
    expect(rows.find((r) => r.key === 'AI_MODEL')).toMatchObject({ state: 'value', value: 'anthropic-claude-haiku-5-5' });
    expect(rows.find((r) => r.key === 'AI_DAILY_BUDGET_USD')).toMatchObject({ state: 'value', value: '2' });
  });

  it('an unset key is "not set", never a placeholder', () => {
    expect(environmentRows(() => undefined).find((r) => r.key === ANTHROPIC_API_KEY_ENV)).toMatchObject({ state: 'not_set', value: null });
  });

  it('every declared *_API_KEY variable is on the allowlist as secret (a new provider key cannot slip in as a plain value)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../environment/environment-variables.ts'), 'utf8');
    const apiKeys = [...source.matchAll(/^\s{2}([A-Z][A-Z0-9_]*_API_KEY)[!?]?:/gm)].map((m) => m[1]!);
    expect(apiKeys).toEqual(expect.arrayContaining([ANTHROPIC_API_KEY_ENV, DEPRECATED_AI_PROVIDER_API_KEY_ENV]));
    for (const key of apiKeys) expect(`${key}:${ENVIRONMENT_ALLOWLIST.find((e) => e.key === key)?.kind}`).toBe(`${key}:secret`);
  });
});
