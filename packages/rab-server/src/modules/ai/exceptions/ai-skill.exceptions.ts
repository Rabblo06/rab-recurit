import { AI_SKILL_LIMITS, AiSkillContentRefusalCode, AiSkillErrorCode } from '@rab/shared';
import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';

/**
 * AI Phase 4 (skills) error shapes. Bodies carry a stable `code` and a fixed, client-safe message — never the skill text,
 * never the matched content of a refused write (category codes only), never another organisation's skill.
 */

/** 400: a skill write broke a write-time content rule (skills/skill-content-rules.ts). `categories` are fixed codes. */
export class AiSkillContentRefusedException extends BadRequestException {
  constructor(readonly categories: readonly AiSkillContentRefusalCode[]) {
    super({ statusCode: HttpStatus.BAD_REQUEST, code: AiSkillErrorCode.SKILL_CONTENT_REFUSED, message: 'This skill cannot be saved.', categories: [...categories] });
  }
}

/** 409: the organisation already has AI_SKILL_LIMITS.maxCustomPerOrganisation custom skills (checked before the trigger). */
export class AiSkillLimitReachedException extends ConflictException {
  constructor() {
    super({
      statusCode: HttpStatus.CONFLICT,
      code: AiSkillErrorCode.SKILL_LIMIT_REACHED,
      message: `An organisation can have at most ${AI_SKILL_LIMITS.maxCustomPerOrganisation} custom skills.`,
      limit: AI_SKILL_LIMITS.maxCustomPerOrganisation,
    });
  }
}

/**
 * 409: a custom skill with this name already exists in the organisation, or the name is a built-in's. No `code` yet: the
 * C0 contract has none for it (requested in REQUEST.md as `AI_SKILL_NAME_TAKEN`); the message is fixed.
 */
export class AiSkillNameTakenException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, message: 'A skill with that name already exists.' });
  }
}

/** 400 at submit (4w): a tagged skill is unknown, inactive, another organisation's, or not readable by this user. */
export class AiSkillNotAvailableException extends BadRequestException {
  constructor() {
    super({ statusCode: HttpStatus.BAD_REQUEST, code: AiSkillErrorCode.SKILL_NOT_AVAILABLE, message: 'That skill is not available.' });
  }
}

/** 400: a named action without a reason of AI_SKILL_LIMITS.reasonMinChars..reasonMaxChars (layer 2; the DTO checks it too). */
export class AiSkillReasonRequiredException extends BadRequestException {
  constructor() {
    super({
      statusCode: HttpStatus.BAD_REQUEST,
      message: `A reason of ${AI_SKILL_LIMITS.reasonMinChars} to ${AI_SKILL_LIMITS.reasonMaxChars} characters is required.`,
    });
  }
}

/** 400: a PATCH that changes nothing (no label, description or content). */
export class AiSkillNothingToChangeException extends BadRequestException {
  constructor() {
    super({ statusCode: HttpStatus.BAD_REQUEST, message: 'Nothing to change.' });
  }
}
