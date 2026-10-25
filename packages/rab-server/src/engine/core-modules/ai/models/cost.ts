import { AiCatalogueModel, AiModelPrice } from './catalog';

/**
 * Estimated provider cost in integer micro-USD (1 USD = 1_000_000). Pure. Every result is rounded UP to the next micro so
 * the budget meter can only over-estimate, never under-estimate. Labelled "estimated": it is computed from the catalogue
 * price and the provider's reported token counts, it is not an invoice, and it is not money in the payroll sense (no
 * pence, no `money.ts`).
 */
export const USD_MICROS = 1_000_000;

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) throw new RangeError('usd must be a positive finite number');
  return Math.round(usd * USD_MICROS);
}

/** The price tier one call pays: the long-context rate applies to the whole call when its prompt passes the threshold. */
export function priceFor(model: Pick<AiCatalogueModel, 'price' | 'longContext'>, inputTokens: number): AiModelPrice {
  return model.longContext && inputTokens > model.longContext.thresholdInputTokens ? model.longContext : model.price;
}

function nonNegativeInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

/** Cost of ONE model call (step) from its token counts. */
export function stepCostUsdMicros(model: Pick<AiCatalogueModel, 'price' | 'longContext'>, inputTokens: number, outputTokens: number): number {
  const input = nonNegativeInt(inputTokens);
  const output = nonNegativeInt(outputTokens);
  const price = priceFor(model, input);
  // tokens ≤ ~1e6 and prices ≤ 2.5e7 micros/MTok keep the product far below 2^53: exact integer arithmetic.
  const numerator = input * price.inputUsdMicrosPerMTok + output * price.outputUsdMicrosPerMTok;
  return Math.ceil(numerator / 1_000_000);
}

/**
 * The most ONE step can cost: the input upper bound (see `maxInputTokensFromBytes`) at the price tier that bound falls in,
 * plus the step's full output allowance. This is what the meter reserves before the call is allowed to start.
 */
export function worstCaseStepUsdMicros(model: Pick<AiCatalogueModel, 'price' | 'longContext' | 'contextWindowTokens'>, maxInputTokens: number, maxOutputTokens: number): number {
  const cappedInput = model.contextWindowTokens ? Math.min(nonNegativeInt(maxInputTokens), model.contextWindowTokens) : nonNegativeInt(maxInputTokens);
  return stepCostUsdMicros(model, cappedInput, maxOutputTokens);
}

/**
 * Upper bound of the input tokens of a prompt of `utf8Bytes` bytes. Byte-level BPE tokenizers (Claude's included) never
 * produce more tokens than the UTF-8 bytes they encode, so bytes are a safe ceiling (typically 3-4× the real count).
 * `framingBytes` covers the provider's own message/tool framing that the serialised prompt does not show.
 */
export function maxInputTokensFromBytes(utf8Bytes: number, framingBytes = 2_048): number {
  return nonNegativeInt(utf8Bytes) + framingBytes;
}
