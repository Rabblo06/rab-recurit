import { PermissionFlagType } from '@rab/shared';
import { z } from 'zod';

import { AiActor } from '../services/ai-access.service';

/**
 * One allowlisted AI tool (docs/ai/PHASE1_PLAN.md, report "Tool definitions"). Everything a tool may do is declared
 * here and enforced by AiToolRegistry, never by the model:
 *  - `kind`: Phase 1 ships READ tools only. A `write` tool cannot be registered (the registry refuses at boot).
 *  - `permission`: checked before the tool is offered to the model AND again, freshly from PostgreSQL, immediately
 *    before it runs.
 *  - `input`: a strict Zod object (unknown keys rejected); re-parsed on the server before every run — the model's
 *    arguments are never trusted, cast or spread.
 *  - `outputKeys`: the explicit allowlist of every key that may leave the tool (nested keys included). Anything else is
 *    dropped; denylisted keys/values are refused or masked by the output guard as a second net.
 *  - `maxRows`: arrays are cut to this length whatever the implementation returned.
 *  - `run`: the server implementation — an EXISTING domain service method, in its own short tenant transaction.
 */
export interface AiToolDefinition<TInput extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  kind: 'read';
  permission: PermissionFlagType;
  input: TInput;
  outputKeys: readonly string[];
  maxRows: number;
  run(actor: AiActor, input: z.infer<TInput>): Promise<Record<string, unknown>>;
}

export const AI_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
