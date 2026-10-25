import { AiCatalogueModel, AiModelPrice } from './catalog';

/**
 * Estimated provider cost in integer micro-USD (1 USD = 1_000_000). Pure. Every result is rounded UP to the next micro so
 * the budget meter can only over-estimate, never under-estimate. Labelled "estimated": it is computed from the catalogue
 * price and the provider's reported token counts, it is not an invoice, and it is not money in the payroll sense (no
 * pence, no `money.ts`).
 *
 * Cache-aware (PHASE1_TWENTY_PLAN §3, C9/D13): `noCache×input + cacheRead×cachedInput + cacheWrite×cacheWrite +
 * output×output`, using the long-context row when the prompt (cache tokens INCLUDED) passes the threshold. When the
 * provider reports no input details, every input token is priced at the input price. Phase 1 sets no `cacheControl`, so
 * Anthropic writes nothing; cached-token counts are not stored separately until Phase 7.
 */
export const USD_MICROS = 1_000_000;

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) throw new RangeError('usd must be a positive finite number');
  return Math.round(usd * USD_MICROS);
}

type PricedModel = Pick<AiCatalogueModel, 'price' | 'longContext'>;

/** Token counts of ONE model call (the AI SDK's step usage). `inputTokens` is the TOTAL input, cache tokens included. */
export interface AiStepUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  inputTokenDetails?: { noCacheTokens?: number | undefined; cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined } | undefined;
}

/** The price tier one call pays: the long-context rate applies to the whole call when its prompt passes the threshold. */
export function priceFor(model: PricedModel, totalInputTokens: number): AiModelPrice {
  return model.longContext && totalInputTokens > model.longContext.thresholdInputTokens ? model.longContext : model.price;
}

function nonNegativeInt(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

/** A provider without a separate cache-write price bills writes as input (never cheaper than input: safe for the meter). */
function cacheWritePrice(p: AiModelPrice): number {
  return p.cacheWriteUsdMicrosPerMTok ?? p.inputUsdMicrosPerMTok;
}

/**
 * Cost of ONE model call (step) from its reported usage. Details that do not add up (no-cache + cache read + cache write
 * ≠ the reported total) are distrusted: the larger of the two totals is then priced at max(input, cacheWrite, cachedInput)
 * — an upper bound of either reading, never below the actual.
 */
export function stepCostUsdMicros(model: PricedModel, usage: AiStepUsage): number {
  const output = nonNegativeInt(usage.outputTokens);
  const d = usage.inputTokenDetails;
  const detailed = d !== undefined && (d.noCacheTokens !== undefined || d.cacheReadTokens !== undefined || d.cacheWriteTokens !== undefined);
  const reportedTotal = usage.inputTokens === undefined ? undefined : nonNegativeInt(usage.inputTokens);
  let numerator: number;
  let price: AiModelPrice;
  if (!detailed) {
    const total = reportedTotal ?? 0;
    price = priceFor(model, total);
    numerator = total * price.inputUsdMicrosPerMTok;
  } else {
    const read = nonNegativeInt(d.cacheReadTokens);
    const write = nonNegativeInt(d.cacheWriteTokens);
    const noCache = d.noCacheTokens !== undefined ? nonNegativeInt(d.noCacheTokens) : Math.max(0, (reportedTotal ?? 0) - read - write);
    const sum = noCache + read + write;
    if (reportedTotal !== undefined && sum !== reportedTotal) {
      const total = Math.max(sum, reportedTotal);
      price = priceFor(model, total);
      numerator = total * Math.max(price.inputUsdMicrosPerMTok, cacheWritePrice(price), price.cachedInputUsdMicrosPerMTok);
    } else {
      price = priceFor(model, sum);
      numerator = noCache * price.inputUsdMicrosPerMTok + read * price.cachedInputUsdMicrosPerMTok + write * cacheWritePrice(price);
    }
  }
  // tokens ≤ ~1e7 and prices ≤ ~3e7 micros/MTok keep every product far below 2^53: exact integer arithmetic.
  numerator += output * price.outputUsdMicrosPerMTok;
  return Math.ceil(numerator / 1_000_000);
}

/**
 * The most ONE step can cost: the input upper bound (see `maxInputTokensFromBytes`, capped at the context window) with
 * EVERY input token priced at max(input, cacheWrite) of the tier that bound falls in — so it stays an upper bound even if
 * the provider writes a cache — plus the step's full output allowance. Reserved before the call may start.
 */
export function worstCaseStepUsdMicros(model: Pick<AiCatalogueModel, 'price' | 'longContext' | 'contextWindowTokens'>, maxInputTokens: number, maxOutputTokens: number): number {
  const cappedInput = Math.min(nonNegativeInt(maxInputTokens), model.contextWindowTokens);
  const price = priceFor(model, cappedInput);
  const perInputToken = Math.max(price.inputUsdMicrosPerMTok, cacheWritePrice(price), price.cachedInputUsdMicrosPerMTok);
  const numerator = cappedInput * perInputToken + nonNegativeInt(maxOutputTokens) * price.outputUsdMicrosPerMTok;
  return Math.ceil(numerator / 1_000_000);
}

/**
 * Upper bound of the input tokens of a prompt of `utf8Bytes` bytes. Byte-level BPE tokenizers (Claude's included) never
 * produce more tokens than the UTF-8 bytes they encode, so bytes are a safe ceiling (typically 3-4× the real count).
 * `framingBytes` covers the provider's own message/tool framing that the serialised prompt does not show.
 */
export function maxInputTokensFromBytes(utf8Bytes: number, framingBytes = 2_048): number {
  return nonNegativeInt(utf8Bytes) + framingBytes;
}
