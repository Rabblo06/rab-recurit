import * as fs from 'fs';
import * as path from 'path';

import { AI_PROVIDER_KEY_ENVS, ANTHROPIC_API_KEY_ENV } from '../ai/models/provider-keys';
import { EnvironmentVariables } from '../environment/environment-variables';
import { ENVIRONMENT_ALLOWLIST, environmentRows } from './admin-config.service';

/**
 * Owner decision 2 / TP-2 / TP-8 / security 4.3 + 12.3: the admin environment viewer shows EVERY provider key as
 * "configured" only. Canary: a recognisable fake value is configured for each and must not appear anywhere in what the
 * viewer returns.
 */
describe('admin environment viewer: AI provider keys are secret-classed (canary)', () => {
  const CANARY = 'sk-ant-api03-CANARY-'.padEnd(64, 'Q');

  it('all five provider key names are listed as secret; the retired names are gone', () => {
    expect([...AI_PROVIDER_KEY_ENVS]).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY']);
    for (const key of AI_PROVIDER_KEY_ENVS) {
      expect(ENVIRONMENT_ALLOWLIST.find((e) => e.key === key)).toEqual({ group: 'AI providers', key, kind: 'secret' });
    }
    for (const retired of ['AI_PROVIDER', 'AI_MODEL', 'AI_PROVIDER_API_KEY']) expect(ENVIRONMENT_ALLOWLIST.some((e) => e.key === retired)).toBe(false);
    for (const key of ['AI_MODELS_DEFAULT_FAST', 'AI_MODELS_DEFAULT_SMART', 'AI_MODELS_DEFAULT_DISABLED'] as const) {
      expect(ENVIRONMENT_ALLOWLIST.find((e) => e.key === key)).toEqual({ group: 'AI providers', key, kind: 'value' });
    }
  });

  it('a configured key is reported as "set" with no value, prefix or length — the canary appears nowhere', () => {
    const values: Partial<Record<keyof EnvironmentVariables, unknown>> = {
      ...Object.fromEntries(AI_PROVIDER_KEY_ENVS.map((k, i) => [k, `${CANARY}-${i}`])),
      AI_MODELS_DEFAULT_FAST: 'anthropic-claude-haiku-5-5',
      AI_DAILY_BUDGET_USD: 2,
      AI_DEV_ALLOW_REAL_PROVIDERS: true,
    };
    const rows = environmentRows((key) => values[key]);
    expect(JSON.stringify(rows)).not.toContain('CANARY');
    for (const key of AI_PROVIDER_KEY_ENVS) expect(rows.find((r) => r.key === key)).toEqual({ group: 'AI providers', key, state: 'set', value: null, source: 'env (secret)' });
    expect(rows.find((r) => r.key === 'AI_MODELS_DEFAULT_FAST')).toMatchObject({ state: 'value', value: 'anthropic-claude-haiku-5-5' });
    expect(rows.find((r) => r.key === 'AI_DAILY_BUDGET_USD')).toMatchObject({ state: 'value', value: '2' });
  });

  it('an unset key is "not set", never a placeholder', () => {
    expect(environmentRows(() => undefined).find((r) => r.key === ANTHROPIC_API_KEY_ENV)).toMatchObject({ state: 'not_set', value: null });
  });

  it('every declared *_API_KEY variable is on the allowlist as secret (a new provider key cannot slip in as a plain value)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../environment/environment-variables.ts'), 'utf8');
    const apiKeys = [...source.matchAll(/^\s{2}([A-Z][A-Z0-9_]*_API_KEY)[!?]?:/gm)].map((m) => m[1]!);
    expect(apiKeys).toEqual(expect.arrayContaining([...AI_PROVIDER_KEY_ENVS]));
    for (const key of apiKeys) expect(`${key}:${ENVIRONMENT_ALLOWLIST.find((e) => e.key === key)?.kind}`).toBe(`${key}:secret`);
  });
});
