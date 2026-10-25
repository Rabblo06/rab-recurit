import { AiProposalFailureCode, AiProposalHttpErrorCode } from '@rab/shared';
import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';

/**
 * AI Phase 5a proposal errors. Fixed, client-safe bodies with a stable `code`; never an argument value, a note body, a
 * record value or an internal reason. A proposal that does not exist FOR THIS CALLER is the Phase 1
 * `AiRecordNotFoundException` (404, the same body whether it belongs to someone else or does not exist).
 */
export class AiProposalExpiredException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, code: AiProposalHttpErrorCode.PROPOSAL_EXPIRED, message: 'This suggestion has expired. Ask the assistant again if you still want it.' });
  }
}

export class AiProposalStaleException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, code: AiProposalHttpErrorCode.PROPOSAL_STALE, message: 'The record changed after this suggestion was made, so it was not applied.' });
  }
}

export class AiProposalNotPendingException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, code: AiProposalHttpErrorCode.PROPOSAL_NOT_PENDING, message: 'This suggestion has already been decided.' });
  }
}

/** 400: an edit outside the proposed editable fields, or edited arguments that fail the tool's strict schema. Paths only. */
export class AiProposalInvalidEditException extends BadRequestException {
  constructor(readonly issues: string[]) {
    super({ statusCode: HttpStatus.BAD_REQUEST, message: 'These changes cannot be applied to this suggestion.', issues });
  }
}

/** 400: a high-impact approval (or any rejection) needs a reason of 3–500 characters. */
export class AiProposalReasonRequiredException extends BadRequestException {
  constructor() {
    super({ statusCode: HttpStatus.BAD_REQUEST, message: 'Give a reason of 3 to 500 characters.' });
  }
}

/** Internal (inside the executor's transaction): the target's snapshot no longer matches. Mapped to 409 STALE + FAILED. */
export class AiProposalStaleError extends Error {
  readonly failureCode: AiProposalFailureCode = 'stale';
  constructor() {
    super('AI proposal target changed since it was proposed');
    this.name = 'AiProposalStaleError';
  }
}

/** Internal: the compare-and-set PENDING → APPROVED matched no row (already decided, or expired). */
export class AiProposalNotDecidableError extends Error {
  constructor() {
    super('AI proposal is not pending');
    this.name = 'AiProposalNotDecidableError';
  }
}
