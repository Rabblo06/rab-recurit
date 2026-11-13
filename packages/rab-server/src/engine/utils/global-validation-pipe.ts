import { INestApplication, ValidationPipe, ValidationPipeOptions } from '@nestjs/common';

/**
 * The ONE global ValidationPipe configuration (CLAUDE.md, Conventions: the anti-mass-assignment control). `whitelist`
 * strips undeclared properties, `forbidNonWhitelisted` turns any undeclared property (an `organisationId`, a `status`,
 * anything the DTO does not declare) into a 400 instead of a silently ignored field, and `transform` gives handlers the
 * DTO instance. main.ts and every test bootstrap apply it through `applyGlobalValidationPipe`, so a spec can never run
 * the API with a weaker pipe, or none, than production does (XA-11).
 */
export const GLOBAL_VALIDATION_PIPE_OPTIONS: Readonly<ValidationPipeOptions> = Object.freeze({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

export function applyGlobalValidationPipe<T extends INestApplication>(app: T): T {
  app.useGlobalPipes(new ValidationPipe({ ...GLOBAL_VALIDATION_PIPE_OPTIONS }));
  return app;
}
