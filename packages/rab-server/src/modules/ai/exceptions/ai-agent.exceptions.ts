import { AI_AGENT_LIMITS, AI_AGENT_REASON_LIMITS, AiAgentErrorCode, AiAgentStorageErrorCode, AiSkillContentRefusalCode } from '@rab/shared';
import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';

/**
 * AI Phase 6a (agent storage) error shapes. Bodies carry a stable `code` and a fixed, client-safe message — never an
 * agent's instruction text, never the matched content of a refused write (category codes only), never another
 * organisation's or workspace's agent (that is always the uniform 404 of AiRecordNotFoundException / AiNotAvailableException).
 */

/** 409: EX-3 is not approved — enabling a trigger (or any run) is refused. The trigger stays stored and switched off. */
export class AiAgentExecutionNotApprovedException extends ConflictException {
  constructor() {
    super({
      statusCode: HttpStatus.CONFLICT,
      code: AiAgentErrorCode.AGENT_EXECUTION_NOT_APPROVED,
      message: 'Agents can’t run until agent execution is approved. The trigger is saved and stays off.',
    });
  }
}

/** 409: a standard or system agent (or its triggers / role) can never be edited or deleted. */
export class AiAgentReadOnlyException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, code: AiAgentStorageErrorCode.READ_ONLY, message: 'This agent is provided by Crewflow and can’t be changed.' });
  }
}

/** 409: a live agent with this name already exists in the workspace. */
export class AiAgentNameTakenException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, code: AiAgentStorageErrorCode.NAME_TAKEN, message: 'An agent with that name already exists.' });
  }
}

/** 409: the workspace already has AI_AGENT_LIMITS.agentsPerWorkspace live agents. */
export class AiAgentLimitReachedException extends ConflictException {
  constructor() {
    super({
      statusCode: HttpStatus.CONFLICT,
      code: AiAgentStorageErrorCode.LIMIT_REACHED,
      message: `A workspace can have at most ${AI_AGENT_LIMITS.agentsPerWorkspace} agents.`,
      limit: AI_AGENT_LIMITS.agentsPerWorkspace,
    });
  }
}

/** 409: the agent already has AI_AGENT_LIMITS.triggersPerAgent triggers. */
export class AiAgentTriggerLimitReachedException extends ConflictException {
  constructor() {
    super({
      statusCode: HttpStatus.CONFLICT,
      code: AiAgentStorageErrorCode.TRIGGER_LIMIT_REACHED,
      message: `An agent can have at most ${AI_AGENT_LIMITS.triggersPerAgent} triggers.`,
      limit: AI_AGENT_LIMITS.triggersPerAgent,
    });
  }
}

/** 400: an agent's text broke a write-time content rule. `categories` are fixed codes (agents/agent-content-rules.ts). */
export class AiAgentContentRefusedException extends BadRequestException {
  constructor(readonly categories: readonly AiSkillContentRefusalCode[]) {
    super({ statusCode: HttpStatus.BAD_REQUEST, code: AiAgentStorageErrorCode.CONTENT_REFUSED, message: 'This agent cannot be saved.', categories: [...categories] });
  }
}

/** 400: a structurally invalid field (model, response format, role, schedule, event types). `field` is a fixed name. */
export class AiAgentInvalidException extends BadRequestException {
  constructor(readonly field: 'model' | 'responseFormat' | 'roleId' | 'trigger' | 'flags') {
    super({ statusCode: HttpStatus.BAD_REQUEST, code: AiAgentStorageErrorCode.INVALID, message: 'This value is not allowed.', field });
  }
}

/**
 * 400: a flag an agent role may not carry in Phase 6a (blocker B10: the member-role backstop is unchanged, so only the
 * three view flags in AI_AGENT_ROLE_FLAGS_6A). The flag keys are server constants, never user content.
 */
export class AiAgentRoleFlagNotAllowedException extends BadRequestException {
  constructor(readonly flags: readonly string[]) {
    super({
      statusCode: HttpStatus.BAD_REQUEST,
      code: AiAgentStorageErrorCode.ROLE_FLAG_NOT_ALLOWED,
      message: 'An agent can’t be given these permissions yet.',
      flags: [...flags],
    });
  }
}

/** 400: a write without a reason of AI_AGENT_REASON_LIMITS.minChars..maxChars (layer 2; the DTO checks it too). */
export class AiAgentReasonRequiredException extends BadRequestException {
  constructor() {
    super({ statusCode: HttpStatus.BAD_REQUEST, message: `A reason of ${AI_AGENT_REASON_LIMITS.minChars} to ${AI_AGENT_REASON_LIMITS.maxChars} characters is required.` });
  }
}

/** 400: a PATCH that changes nothing. */
export class AiAgentNothingToChangeException extends BadRequestException {
  constructor() {
    super({ statusCode: HttpStatus.BAD_REQUEST, message: 'Nothing to change.' });
  }
}
