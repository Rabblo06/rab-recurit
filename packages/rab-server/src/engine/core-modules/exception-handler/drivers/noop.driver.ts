import type { ExceptionHandlerDriverInterface } from '../interfaces/exception-handler-driver.interface';

/**
 * The driver when Sentry is off (no `SENTRY_DSN`, or no Sentry client in this process). Twenty's off-driver is a
 * console driver; Crewflow's is a no-op because both callers (AllExceptionsFilter's 500 branch and the Worker cycle
 * catch) already log the failure themselves, so a console driver would only print it twice.
 */
export class ExceptionHandlerNoopDriver implements ExceptionHandlerDriverInterface {
  captureExceptions(): string[] {
    return [];
  }
}
