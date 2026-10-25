import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

import { DeterministicMockModel } from '../../../modules/ai/gateway/deterministic-mock-model';

/**
 * Recorded / scripted models for the AI suites (deterministic CI — no provider is ever called). Built on the SDK's own
 * `MockLanguageModelV3` (ai/test) and `simulateReadableStream`.
 */
export const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

export const textParts = (text: string, u = usage(10, 5)): LanguageModelV3StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  ...(text.match(/\S+\s*/g) ?? [text]).map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: u },
];

export const toolCallParts = (toolName: string, input: unknown, u = usage(10, 5), id = `call_${toolName}`): LanguageModelV3StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: u },
];

/** A model that answers step N with `script[N]` (the last entry repeats) and records every prompt/tool list it saw. */
export function scriptedModel(script: Array<LanguageModelV3StreamPart[] | ((o: LanguageModelV3CallOptions) => LanguageModelV3StreamPart[])>, opts: { chunkDelayInMs?: number } = {}) {
  const seen: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options: LanguageModelV3CallOptions) => {
      seen.push(options);
      const step = script[Math.min(seen.length - 1, script.length - 1)]!;
      const chunks = typeof step === 'function' ? step(options) : step;
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: opts.chunkDelayInMs ?? null, initialDelayInMs: null }) };
    },
  });
  return { model: model as unknown as LanguageModelV3, seen };
}

/** A model whose stream never ends until aborted (timeout / cancel / shutdown tests); it emits some text first. */
export function hangingModel(prefix = 'Working on it ') {
  const seen: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options: LanguageModelV3CallOptions) => {
      seen.push(options);
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't1' });
          controller.enqueue({ type: 'text-delta', id: 't1', delta: prefix });
          options.abortSignal?.addEventListener('abort', () => controller.error(options.abortSignal?.reason ?? new Error('aborted')));
        },
      });
      return { stream };
    },
  });
  return { model: model as unknown as LanguageModelV3, seen };
}

/** A provider outage: every call fails before streaming. */
export function failingModel() {
  const seen: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options: LanguageModelV3CallOptions) => {
      seen.push(options);
      throw Object.assign(new Error('provider unavailable (status 503) for prompt <redacted>'), { statusCode: 503 });
    },
  });
  return { model: model as unknown as LanguageModelV3, seen };
}

/** The deterministic default, wrapped to count calls (proves a reconnect / duplicate never calls the model again). */
export function countingDeterministicModel() {
  const inner = new DeterministicMockModel('crewflow-mock-1');
  const calls = { n: 0 };
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: {},
    doGenerate: (o) => inner.doGenerate(o),
    doStream: (o) => {
      calls.n += 1;
      return inner.doStream(o);
    },
  };
  return { model, calls };
}
