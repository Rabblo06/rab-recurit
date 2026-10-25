import type { EnvironmentVariables } from '../../environment/environment-variables';

/**
 * AI Part A (docs/ai/PART_A_PLAN.md, owner decision 2): the ONE place the Anthropic key's environment-variable NAME is
 * written in server code. `EnvironmentVariables` declares the property (it is the validation schema, and the worker
 * launcher's reconciliation test reads that declaration); everything else — the gateway, the readiness checks, the admin
 * environment viewer — refers to this constant. `ai-provider-boundary.spec.ts` fails if the literal appears anywhere else.
 *
 * Deviation from security spec 4.3 (`AI_<PROVIDER>_API_KEY`), pending the owner's confirmation: this is the Twenty-style
 * name, which is also the name `@ai-sdk/anthropic` reads from `process.env` when no `apiKey` is passed. Mitigations
 * (all required by the owner): the key is read only through EnvironmentService and passed EXPLICITLY to
 * `createAnthropic({ apiKey, baseURL })` with a fixed baseURL; a static scan refuses the SDK's default `anthropic`
 * instance (the one that auto-reads the environment) and any `@ai-sdk/*` import outside the gateway; the admin
 * environment viewer classes it `secret` ("configured" only).
 */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY' as const satisfies keyof EnvironmentVariables;

/** Deprecated (one release): the Phase 1 generic key name, honoured only through the alias rules in ai-readiness.ts. */
export const DEPRECATED_AI_PROVIDER_API_KEY_ENV = 'AI_PROVIDER_API_KEY' as const satisfies keyof EnvironmentVariables;

/** Every provider key variable (all secret-classed in the admin environment viewer). */
export const AI_PROVIDER_KEY_ENVS = [ANTHROPIC_API_KEY_ENV, DEPRECATED_AI_PROVIDER_API_KEY_ENV] as const;
export type AiProviderKeyEnv = (typeof AI_PROVIDER_KEY_ENVS)[number];

/**
 * The fixed Anthropic endpoint. Always passed explicitly, so `ANTHROPIC_BASE_URL` (the SDK's environment fallback) is
 * never read. There is no `*_BASE_URL` configuration anywhere: changing the endpoint is a reviewed code change.
 */
export const ANTHROPIC_FIXED_BASE_URL = 'https://api.anthropic.com/v1';
