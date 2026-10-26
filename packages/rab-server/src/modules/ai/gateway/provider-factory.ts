// The ONLY file in the repository that may import a provider SDK (`@ai-sdk/<provider>`). Enforced by
// src/__tests__/static/ai-provider-boundary.spec.ts.
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { AiModelEffort } from '@rab/shared';

import { AiCatalogueModel } from '../../../engine/core-modules/ai/models/catalog';
import { ANTHROPIC_FIXED_BASE_URL } from '../../../engine/core-modules/ai/models/provider-keys';
import { AiModelNotConfiguredError } from './ai-gateway-errors';

export interface ProviderModelRequest {
  model: AiCatalogueModel;
  /** Resolved by the gateway from EnvironmentService. Never read from `process.env` here. */
  apiKey: string | null;
  /** Test seam only (recorded-request unit test). Production never passes it. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The provider call options for one call: a deep copy of the catalogue's FIXED `providerOptions`, with the level's effort
 * (already checked as VERIFIED for this model by the gateway) under the provider's own key. Only Anthropic has an effort
 * option in this build; for any other provider an effort adds nothing (in-process test models never leave the process).
 * Nothing from a user, a pin or a request reaches here except the enum value.
 */
export function providerCallOptions(model: AiCatalogueModel, effort?: AiModelEffort): Record<string, Record<string, string>> | undefined {
  const base = model.providerOptions ? (JSON.parse(JSON.stringify(model.providerOptions)) as Record<string, Record<string, string>>) : undefined;
  if (effort === undefined || model.provider !== 'anthropic') return base;
  return { ...(base ?? {}), anthropic: { ...(base?.anthropic ?? {}), effort } };
}

/**
 * Builds the SDK model object for a catalogue entry. Every option is an explicit value, so no SDK environment fallback is
 * ever consulted: `apiKey` is always a non-empty string (an empty one would make `@ai-sdk/anthropic` read
 * `ANTHROPIC_API_KEY` itself), `baseURL` is the fixed catalogue endpoint (never `ANTHROPIC_BASE_URL`), there is no
 * `authToken` (so `ANTHROPIC_AUTH_TOKEN` is never read) and no provider-defined tools. The SDK's default `anthropic`
 * instance — which reads the environment on its own — is never used. Returns a model OBJECT: a string model id would be
 * routed by `ai` to the Vercel AI Gateway.
 */
export function createProviderModel(req: ProviderModelRequest): LanguageModelV3 {
  const { model, apiKey } = req;
  if (model.provider !== 'anthropic' || !model.sdkInstalled) throw new AiModelNotConfiguredError();
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new AiModelNotConfiguredError();
  if (model.baseURL !== ANTHROPIC_FIXED_BASE_URL) throw new AiModelNotConfiguredError();
  try {
    const provider = createAnthropic({ apiKey, baseURL: ANTHROPIC_FIXED_BASE_URL, ...(req.fetch ? { fetch: req.fetch } : {}) });
    return provider.languageModel(model.providerModelId) as LanguageModelV3;
  } catch {
    // Never rethrow the SDK's error: its message could describe the options it was given.
    throw new AiModelNotConfiguredError();
  }
}
