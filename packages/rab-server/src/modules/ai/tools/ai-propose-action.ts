import type { z } from 'zod';

import { publishedInputSchema } from './ai-meta-tools';

/**
 * AI 5b: the `propose_action` pause tool as the model sees it — fixed server text only, byte-stable for a given set of
 * permitted write tools (name-sorted). The write tools themselves are never SDK tools: the model can only PROPOSE, a person
 * decides in Crewflow, and only the executor (an APPROVED proposal, inside the approve transaction) ever applies one.
 */

/** One fixed line per write tool (what a proposal of it would do). */
const WRITE_TOOL_LINES: Readonly<Record<string, string>> = Object.freeze({
  create_draft_shift: 'create_draft_shift: draft a NEW shift. It stays a DRAFT (never published, nobody is offered it) and uses the standard pay of the job role.',
  update_draft_shift: 'update_draft_shift: change fields of an existing DRAFT shift (never its status or pay).',
  add_staff_note: "add_staff_note: add a note to a staff member's profile. The text is saved exactly as proposed.",
});

export function proposeActionDescription(writeToolNames: readonly string[], inputOf: (name: string) => z.ZodType): string {
  const lines = [...writeToolNames].sort().map((name) => {
    const schema = JSON.stringify(publishedInputSchema(inputOf(name)));
    return `- ${WRITE_TOOL_LINES[name] ?? name} Arguments (JSON schema): ${schema}`;
  });
  return [
    'Propose ONE change for the user to approve in Crewflow. Nothing changes until a person approves it; you cannot approve it and you must not say it is done.',
    'After proposing, stop and wait: the user decides, and you will then be told the outcome. Use alternativeOf (a proposalId) to offer an alternative to a pending proposal.',
    'Changes you may propose:',
    ...lines,
  ].join('\n');
}

/** The SDK input schema: the tool narrowed to THIS user's permitted write tools; arguments re-parsed strictly server-side. */
export function proposeActionJsonSchema(writeToolNames: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: [...writeToolNames].sort() },
      arguments: { type: 'object' },
      alternativeOf: { type: 'string', format: 'uuid' },
    },
    required: ['tool', 'arguments'],
    additionalProperties: false,
  };
}
