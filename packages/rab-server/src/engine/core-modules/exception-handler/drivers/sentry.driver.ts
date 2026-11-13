import * as Sentry from '@sentry/node';

import type { ExceptionHandlerDriverInterface, ExceptionHandlerOptions } from '../interfaces/exception-handler-driver.interface';

/** The two Sentry calls the driver makes (injectable so a test can make Sentry itself fail). */
export interface SentryCaptureApi {
  withScope(callback: (scope: Sentry.Scope) => void): void;
  captureException(exception: unknown): string;
}

/**
 * Sends each exception to Sentry in its own scope (Twenty: exception-handler/drivers/sentry.driver.ts). The event then
 * goes through the `beforeSend` scrubber that `instrument.ts` installed with `Sentry.init`, which removes request
 * headers (Authorization, Cookie), cookies, bodies, query strings, users other than an opaque id, JWTs, bearer tokens,
 * `password=` / `token=` / `secret=` values, MFA fields and email addresses, and drops the event if scrubbing throws.
 *
 * Unlike Twenty's driver this one copies nothing off the exception object (no `exception.context` into `extra`, no
 * `cause` stack into a context): the only extras are the two fixed operation fields below.
 */
export class ExceptionHandlerSentryDriver implements ExceptionHandlerDriverInterface {
  constructor(private readonly sentry: SentryCaptureApi = Sentry) {}

  captureExceptions(exceptions: ReadonlyArray<unknown>, options?: ExceptionHandlerOptions): string[] {
    const eventIds: string[] = [];
    this.sentry.withScope((scope) => {
      if (options?.operation) {
        scope.setExtra('operation', options.operation.name);
        scope.setExtra('operationType', options.operation.type);
      }
      for (const exception of exceptions) {
        eventIds.push(this.sentry.captureException(exception));
      }
    });
    return eventIds;
  }
}
