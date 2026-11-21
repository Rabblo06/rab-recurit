import { HttpStatus, UnprocessableEntityException } from '@nestjs/common';

/** Stable error code of a search that ran past its statement timeout. */
export const SEARCH_TOO_BROAD = 'SEARCH_TOO_BROAD';

/**
 * 422: the search statement hit the search transaction's own `statement_timeout` (SQLSTATE 57014). The term matches too
 * much to rank within the bound, so the caller is asked to narrow it. Before (M9 load test §4.4) this surfaced as an
 * unhandled 500; a 4xx is the truth (nothing failed on the server side), is not counted as a server error, and is not
 * retried by the console's query client (a 5xx was retried once, paying the 5 s timeout twice). Fixed, client-safe
 * message: never the term, never a row.
 */
export class SearchTooBroadException extends UnprocessableEntityException {
  constructor() {
    super({ statusCode: HttpStatus.UNPROCESSABLE_ENTITY, code: SEARCH_TOO_BROAD, message: 'That search matches too much. Type more of the name.' });
  }
}

/** SQLSTATE 57014 (query_canceled: statement_timeout), on a pg error or on TypeORM's QueryFailedError wrapping one. */
export function isStatementTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; driverError?: { code?: unknown } };
  return e.code === '57014' || e.driverError?.code === '57014';
}
