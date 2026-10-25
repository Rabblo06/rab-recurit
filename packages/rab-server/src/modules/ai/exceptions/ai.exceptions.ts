import { AiErrorCode, AiErrorCodeType } from '@rab/shared';
import { BadRequestException, ConflictException, HttpException, HttpStatus, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

/**
 * AI Phase 1 error shapes. Bodies carry a stable `code` and a fixed, client-safe message — never a prompt, a record
 * value, a provider message or an internal reason. Which gate refused an "unavailable" request is deliberately NOT in
 * the body (one uniform 404 for kill switch / org switch / permission / eligibility / workspace / inspection); the UI
 * learns its own state from `GET /rest/v1/ai/availability`.
 */
export class AiNotAvailableException extends NotFoundException {
  constructor() {
    super({ statusCode: HttpStatus.NOT_FOUND, code: AiErrorCode.NOT_AVAILABLE, message: 'Not found.' });
  }
}

/** A conversation or turn that does not exist for this caller — the same body whether it exists for someone else or not. */
export class AiRecordNotFoundException extends NotFoundException {
  constructor() {
    super({ statusCode: HttpStatus.NOT_FOUND, message: 'Not found.' });
  }
}

export class AiTooManyRequestsException extends HttpException {
  constructor(
    code: typeof AiErrorCode.RATE_LIMITED | typeof AiErrorCode.ORG_BUSY | typeof AiErrorCode.BUDGET_EXHAUSTED,
    readonly retryAfterSeconds: number,
  ) {
    const message =
      code === AiErrorCode.RATE_LIMITED
        ? 'You are sending questions too quickly. Try again shortly.'
        : code === AiErrorCode.ORG_BUSY
          ? 'Your organisation already has the maximum number of AI questions in progress. Try again shortly.'
          : 'Your organisation has used its AI allowance for today.';
    super({ statusCode: HttpStatus.TOO_MANY_REQUESTS, code, message, retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export class AiServiceUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({ statusCode: HttpStatus.SERVICE_UNAVAILABLE, code: AiErrorCode.SERVICE_UNAVAILABLE, message: 'The AI assistant is temporarily unavailable.' });
  }
}

export class AiInputTooLongException extends BadRequestException {
  constructor(maxChars: number) {
    super({ statusCode: HttpStatus.BAD_REQUEST, code: AiErrorCode.INPUT_TOO_LONG, message: `Questions are limited to ${maxChars} characters.`, maxChars });
  }
}

export class AiConflictException extends ConflictException {
  constructor(code: typeof AiErrorCode.TURN_IN_PROGRESS | typeof AiErrorCode.CONVERSATION_FULL) {
    super({
      statusCode: HttpStatus.CONFLICT,
      code,
      message: code === AiErrorCode.TURN_IN_PROGRESS ? 'An answer is still being prepared in this conversation.' : 'This conversation is full. Start a new one.',
    });
  }
}

/**
 * Thrown inside the Worker when the caller's authority is gone (session ended, account/organisation suspended, AI or a
 * permission revoked, a switch turned off): the turn stops at once and ends `failed` / AI_ACCESS_REVOKED.
 */
export class AiAccessRevokedError extends Error {
  readonly code: AiErrorCodeType = AiErrorCode.ACCESS_REVOKED;
  constructor(readonly reason: string) {
    super(`AI access revoked (${reason})`);
    this.name = 'AiAccessRevokedError';
  }
}

/** Redis/quota infrastructure failure: new AI work is refused (fail closed). */
export class AiQuotaUnavailableError extends Error {
  constructor() {
    super('AI quota store unavailable');
    this.name = 'AiQuotaUnavailableError';
  }
}
