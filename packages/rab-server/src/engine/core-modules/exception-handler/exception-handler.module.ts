import { Global, Module } from '@nestjs/common';

import { EXCEPTION_HANDLER_DRIVER } from './exception-handler.constants';
import { createExceptionHandlerDriver } from './exception-handler-driver.factory';
import { ExceptionHandlerService } from './exception-handler.service';

/**
 * Twenty: exception-handler/exception-handler.module.ts (global module, one driver provider, the service exported).
 * The driver is chosen from `process.env`, the same source `instrument.ts` reads before Nest starts, so the module and
 * `Sentry.init` can never disagree on whether Sentry is on.
 */
@Global()
@Module({
  providers: [
    { provide: EXCEPTION_HANDLER_DRIVER, useFactory: () => createExceptionHandlerDriver(process.env) },
    ExceptionHandlerService,
  ],
  exports: [ExceptionHandlerService],
})
export class ExceptionHandlerModule {}
