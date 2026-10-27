import { AiToolCallSummaryV2 } from '@rab/shared';
import { z } from 'zod';

import type { AiToolDefinitionV2, AiToolRunEmitter, AiTurnToolBudget } from '../contracts/tools';
import { AiActor } from '../services/ai-access.service';

/**
 * One allowlisted AI tool (Phase 1 shape + the Phase 3 fields; target type `AiToolDefinitionV2` in modules/ai/contracts).
 * Everything a tool may do is declared with `@DefineTool()` on its class (tools/read/*.tool.ts) and enforced by
 * AiToolRegistry, never by the model:
 *  - `kind`: Phase 3 registers READ tools only; `pause` / `write` (Phase 5b) and an `approval` template refuse at boot.
 *  - `permission`: ONE flag (rule 2.4), checked before the tool is listed in the catalogue AND again, freshly from
 *    PostgreSQL, immediately before it runs.
 *  - `input`: a strict Zod object (unknown keys rejected); re-parsed on the server before every run — the ONLY inner check
 *    once tools load lazily through `execute_tool` (rule 7.1). The model's arguments are never trusted, cast or spread.
 *  - `outputKeys`: the explicit allowlist of every key that may leave the tool (nested keys included).
 *  - `maxRows` / `maxBytes`: arrays are cut to `maxRows`; the wrapped JSON is cut (rows only, never a string) to `maxBytes`.
 *  - `run`: the server implementation — an EXISTING domain service `assistant*` method, in its own short tenant
 *    transaction, as the user.
 */
export type AiToolDefinition<TInput extends z.ZodType = z.ZodType> = AiToolDefinitionV2<TInput>;

export const AI_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * What one tool call needs from the turn. The Phase 1 `AiToolRunContext` (runner, `buildToolSet`) and the target
 * `AiToolRunContextV2` (`forTurn`, 3w) both satisfy it: `emit` and `budget` are optional so the unchanged Phase 1 runner
 * keeps working; the registry keeps its own per-turn budget for a context that carries none.
 */
export interface AiToolExecutionContext {
  actor: AiActor;
  turnId: string;
  conversationId: string;
  /** Stops the whole turn (access revoked mid-turn). */
  abortTurn: (reason: 'access_revoked') => void;
  /** Metadata of every executed/refused call, persisted on the turn (never arguments or results). */
  calls: AiToolCallSummaryV2[];
  emit?: AiToolRunEmitter;
  budget?: AiTurnToolBudget;
}
