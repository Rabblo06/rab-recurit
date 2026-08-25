import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

/**
 * The backstop below Nest's own unregistered-exception default (which
 * already doesn't leak stack traces/SQL to the client — verified — but
 * that guarantee lived only in framework behavior this codebase never
 * asserted in code). `@Catch()` with no argument matches everything, so
 * this MUST be declared *before* `InvalidTransitionFilter` in
 * `AppModule.providers` — Nest checks `APP_FILTER` providers in *reverse*
 * registration order (confirmed empirically: the intuitive "declare the
 * catch-all last" ordering made it run first and shadow
 * `InvalidTransitionFilter`, turning every InvalidTransitionError into a
 * generic 500 instead of the documented 409). Declared first, it's
 * checked last, only after every more-specific filter has had a chance.
 *
 * Already-thrown `HttpException`s (`NotFoundException`, `ConflictException`,
 * everything `ValidationPipe` throws, etc.) are deliberately client-safe
 * messages written by this codebase on purpose — passed through unchanged.
 * Anything else (a raw driver error, an unexpected null-pointer bug) is
 * logged here in full and converted to a generic 500 — the client never
 * sees `error.message`/`error.stack`/a raw Postgres error.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
