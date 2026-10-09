import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { MulterError } from 'multer';
import { EntityNotFoundError } from 'typeorm';

import { WorkspaceRoutingError } from '../core-modules/tenant/schema-resolver.service';

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
 *
 * PHASE 11 / DEP-01: a `MulterError` is also client-safe by construction
 * (Multer's own fixed, short, non-sensitive messages — "File too large",
 * "Field name array index too large", etc. — never a stack trace, path or
 * package version) but is NOT an `HttpException`, so without this check it
 * would fall through to the generic 500 below. `@nestjs/platform-express`'s
 * own `FileInterceptor` already converts most Multer/Busboy error codes to
 * a proper `BadRequestException`/`PayloadTooLargeException` before this
 * filter ever sees them (`multer.utils.js`'s `transformException`), but it
 * doesn't yet recognise Multer 2.3+'s newer `LIMIT_FIELD_ARRAY_INDEX` code
 * (`fieldArrayIndexLimit`, added for CVE-2026-82333) — this is the backstop
 * for that gap, and for any future Multer error code NestJS's own mapping
 * hasn't caught up to yet, so a malformed upload always gets a real 400,
 * never an opaque 500.
 *
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

    if (exception instanceof MulterError) {
      response.status(HttpStatus.BAD_REQUEST).json({ statusCode: HttpStatus.BAD_REQUEST, message: exception.message });
      return;
    }

    // `findOneByOrFail` throws this when a lookup returns no row. Under RLS that includes a row the caller is not entitled to see, which
    // must look exactly like a row that does not exist: 404, the same body either way. Without this, an out-of-scope record surfaced as a
    // logged 500 (CLAUDE.md: 404, not 500, for a record outside the caller's tenant, venue or own scope).
    if (exception instanceof EntityNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({ statusCode: HttpStatus.NOT_FOUND, message: 'Not found.' });
      return;
    }

    // HWS runtime cutover (`runInWorkspaceContext`'s fail-closed boundary) — same "look exactly like missing" rule as
    // EntityNotFoundError above, deliberately, for every one of WorkspaceRoutingError's codes (missing-context,
    // registry-missing, not-ready, name-mismatch, unsupported-version): a caller with no trusted workspace, or whose
    // workspace isn't routable yet, must see the same 404 an out-of-scope record gets — never a 403 (which would
    // confirm something exists) and never an opaque 500 (which this error's own fixed, non-sensitive `message` never
    // needed in the first place — see that class's own doc comment for why it carries no schema name or row content).
    if (exception instanceof WorkspaceRoutingError) {
      response.status(HttpStatus.NOT_FOUND).json({ statusCode: HttpStatus.NOT_FOUND, message: 'Not found.' });
      return;
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
