import 'reflect-metadata';

import { z } from 'zod';

import type { AiDefinedReadTool, DefineToolOptions } from '../contracts/tools';
import { AI_TOOL_DEFAULT_OUTPUT_BYTES } from './ai-tool.constants';
import { AiToolDefinition } from './ai-tool.types';

/** Reflect-metadata key of `@DefineTool()` options (one per class; never global state). */
export const AI_TOOL_METADATA = 'crewflow:ai:tool-definition';

/**
 * `@DefineTool(options)` (AI Phase 3, docs/ai/PHASE3_TWENTY_PLAN.md §2.1): declares, on an `@Injectable()` class that
 * implements `run(actor, input)`, everything the registry enforces — name, fixed description and catalogue summary, kind,
 * ONE permission flag, the strict input schema, the output allowlist and bounds. It only STORES the options on the class
 * (`Reflect.defineMetadata`); nothing registers itself: the registry reads tools only from the one reviewed array
 * `AI_READ_TOOLS` (tools/index.ts), and `AiToolRegistry.validate` checks every definition at boot (fail closed).
 */
export function DefineTool<TInput extends z.ZodType>(options: DefineToolOptions<TInput>): ClassDecorator {
  return (target) => {
    if (Reflect.hasOwnMetadata(AI_TOOL_METADATA, target)) throw new Error(`@DefineTool applied twice on ${target.name}`);
    Reflect.defineMetadata(AI_TOOL_METADATA, Object.freeze({ ...options }), target);
  };
}

/** The options declared on a tool class, or undefined (a class without `@DefineTool` is never a tool). */
export function definedToolOptions(target: object): DefineToolOptions | undefined {
  return Reflect.getOwnMetadata(AI_TOOL_METADATA, target) as DefineToolOptions | undefined;
}

/** Metadata + the instance's `run` → the registry's definition (validated afterwards by `AiToolRegistry.validate`). */
export function toToolDefinition(instance: AiDefinedReadTool): AiToolDefinition {
  const options = definedToolOptions(instance.constructor);
  if (!options) throw new Error(`AI tool class ${instance.constructor.name} has no @DefineTool() metadata`);
  return {
    name: options.name,
    description: options.description,
    summary: options.summary,
    kind: options.kind,
    permission: options.permission,
    input: options.input,
    outputKeys: Object.freeze([...options.output.keys]),
    maxRows: options.output.maxRows,
    maxBytes: options.output.maxBytes ?? AI_TOOL_DEFAULT_OUTPUT_BYTES,
    limits: Object.freeze({ ...(options.limits ?? {}) }),
    ...(options.approval ? { approval: options.approval } : {}),
    run: (actor, input) => instance.run(actor, input),
  };
}
