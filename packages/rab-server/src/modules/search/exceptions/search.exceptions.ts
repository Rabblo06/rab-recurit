import { HttpStatus, Logger, UnprocessableEntityException } from '@nestjs/common';

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

/**
 * A GENUINE statement timeout: SQLSTATE 57014 (query_canceled) with PostgreSQL's statement-timeout message, on a pg error or
 * on TypeORM's QueryFailedError wrapping one. 57014 alone also covers `pg_cancel_backend` ("canceling statement due to user
 * request") and other cancels; those are not "too broad" and stay server errors. The message is the server's English text
 * (lc_messages is not changed by this deployment; a localised server would fall back to the 5xx, never the other way).
 */
const STATEMENT_TIMEOUT_MESSAGE = /canceling statement due to statement timeout/i;

export function isStatementTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown; driverError?: { code?: unknown; message?: unknown } };
  const timeout = (code: unknown, message: unknown) => code === '57014' && typeof message === 'string' && STATEMENT_TIMEOUT_MESSAGE.test(message);
  return timeout(e.code, e.message) || timeout(e.driverError?.code, e.driverError?.message);
}

const logger = new Logger('SearchService');
let tooBroadCount = 0;

/** How many searches this process answered with SEARCH_TOO_BROAD (the DB-side timeout itself is also counted per pool). */
export function searchTooBroadCount(): number {
  return tooBroadCount;
}

/** Counts and logs (term length only, never the term) one SEARCH_TOO_BROAD answer, and returns the exception to throw. */
export function tooBroad(termLength: number): SearchTooBroadException {
  tooBroadCount += 1;
  logger.warn(`search statement timeout answered ${HttpStatus.UNPROCESSABLE_ENTITY} ${SEARCH_TOO_BROAD} (term length ${termLength}, total ${tooBroadCount})`);
  return new SearchTooBroadException();
}
