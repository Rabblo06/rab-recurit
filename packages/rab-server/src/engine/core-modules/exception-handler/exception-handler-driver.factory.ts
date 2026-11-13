import * as Sentry from '@sentry/node';

import { ExceptionHandlerNoopDriver } from './drivers/noop.driver';
import { ExceptionHandlerSentryDriver } from './drivers/sentry.driver';
import type { ExceptionHandlerDriverInterface } from './interfaces/exception-handler-driver.interface';

type DriverEnv = Readonly<Record<string, string | undefined>>;

/**
 * Picks the driver (Twenty: exception-handler.module-factory.ts picks SENTRY or CONSOLE from EXCEPTION_HANDLER_DRIVER).
 * Crewflow keeps its existing switch instead of adding a second one: Sentry is on exactly when `SENTRY_DSN` is set, which
 * is the condition under which `instrument.ts` calls `Sentry.init` (`buildSentryOptions` returns undefined without it).
 * The client check covers a process that never imported `instrument.ts` (a test, a tool): no client → no-op, so a capture
 * can never go through an uninitialised or unscrubbed Sentry.
 */
export function createExceptionHandlerDriver(
  env: DriverEnv,
  hasSentryClient: () => boolean = () => Sentry.getClient() !== undefined,
): ExceptionHandlerDriverInterface {
  if (!env.SENTRY_DSN || !hasSentryClient()) return new ExceptionHandlerNoopDriver();
  return new ExceptionHandlerSentryDriver();
}
