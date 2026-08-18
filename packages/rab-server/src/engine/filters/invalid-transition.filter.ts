import { InvalidTransitionError } from '@rab/shared';
import { ArgumentsHost, Catch, ConflictException, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';

/**
 * `assertTransition` (CLAUDE.md, rab-workforce-architecture.md §1.1) throws
 * a plain `Error` subclass, not a NestJS `HttpException` — without this
 * filter it falls through Nest's default handler as an unmapped 500 instead
 * of the 409 every state-machine guard in this codebase is documented to
 * return.
 */
@Catch(InvalidTransitionError)
export class InvalidTransitionFilter implements ExceptionFilter {
  catch(exception: InvalidTransitionError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const conflict = new ConflictException(
      `Invalid transition: ${String(exception.from)} -> ${exception.to}`,
    );
    const body = conflict.getResponse();
    response.status(conflict.getStatus()).json(body);
  }
}
