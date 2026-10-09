import { CallHandler, ExecutionContext, Injectable, NestInterceptor, NotFoundException } from '@nestjs/common';
import { Observable } from 'rxjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path parameters that name a record: `:id`, `:staffId`, `:targetUserId`, `:venueId`, ... */
const RECORD_PARAM_PATTERN = /^id$|Id$/;

/**
 * Hyper Workspace Phase 3, Part 4 — malformed identifiers never reach the database.
 *
 * Root cause of the reported `invalid input syntax for type uuid: "undefined"` 500s: a client (or a test that
 * read `body.id` from a failed create) sent `/rest/v1/staff/undefined`. The `:id` path parameter was bound straight
 * into a uuid column, PostgreSQL raised 22P02, and the unhandled error became a 500.
 *
 * Fix at the boundary: a record identifier that is not a UUID cannot name any record, so the answer is the same as for
 * any absent record — 404, never 500 and never a database error. Global interceptors run AFTER guards, so an
 * unauthenticated caller still gets 401 first and learns nothing about which identifiers exist.
 */
@Injectable()
export class UuidPathParamsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const params = context.switchToHttp().getRequest<{ params?: Record<string, unknown> }>().params ?? {};
    for (const [key, value] of Object.entries(params)) {
      if (RECORD_PARAM_PATTERN.test(key) && typeof value === 'string' && !UUID_PATTERN.test(value)) {
        throw new NotFoundException('Not found.');
      }
    }
    return next.handle();
  }
}
