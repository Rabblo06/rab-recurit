import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';

import { EXCEPTION_HANDLER_DRIVER } from './exception-handler.constants';
import { createExceptionHandlerDriver } from './exception-handler-driver.factory';
import type { ExceptionHandlerDriverInterface, ExceptionHandlerOptions } from './interfaces/exception-handler-driver.interface';

/**
 * Twenty's `shouldCaptureException` (engine/utils/global-exception-handler.util.ts): only server faults are reported. A
 * client error (an `HttpException` below 500, or a known status below 500) never reaches Sentry.
 */
export function shouldCaptureException(exception: unknown, statusCode?: number): boolean {
  if (exception instanceof HttpException && exception.getStatus() < 500) return false;
  if (statusCode !== undefined && statusCode < 500) return false;
  return true;
}

/**
 * Reports server errors to the configured driver (Twenty: exception-handler/exception-handler.service.ts). Never throws:
 * a failing driver is logged with a fixed line and the caller carries on, so reporting can never change an HTTP response
 * or fail a Worker cycle.
 */
@Injectable()
export class ExceptionHandlerService {
  private readonly logger = new Logger('ExceptionHandlerService');

  constructor(@Inject(EXCEPTION_HANDLER_DRIVER) private readonly driver: ExceptionHandlerDriverInterface) {}

  captureExceptions(exceptions: ReadonlyArray<unknown>, options?: ExceptionHandlerOptions): string[] {
    try {
      return this.driver.captureExceptions(exceptions, options);
    } catch {
      // Fixed text only: the driver's own error could quote the exception it was reporting.
      this.logger.warn('the exception handler driver failed; the error was not reported');
      return [];
    }
  }
}

let processDefault: ExceptionHandlerService | undefined;

/**
 * The same service for code that is not built by Nest DI (the Worker's WorkerRuntime is created by hand in main.ts and
 * workspace-provisioner.main.ts). Created on first use, after the entrypoint's `instrument` import has run.
 */
export function defaultExceptionHandlerService(): ExceptionHandlerService {
  processDefault ??= new ExceptionHandlerService(createExceptionHandlerDriver(process.env));
  return processDefault;
}
