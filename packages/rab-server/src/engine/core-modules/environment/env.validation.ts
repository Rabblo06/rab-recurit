import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { EnvironmentVariables } from './environment-variables';

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  // `KEY=` in a .env file sets an empty string, not undefined — @IsOptional()
  // only skips null/undefined, so an unset-but-present optional var (e.g.
  // SENTRY_DSN left blank, matching .env.example's own convention) would
  // otherwise fail its @IsUrl()/etc. validator instead of being treated as
  // "not provided". The key must be deleted entirely, not just set to
  // undefined — plainToInstance only falls back to a class's default
  // property initializer when the key is absent, not when it's present
  // with value undefined.
  const normalised = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== ''),
  );

  const validated = plainToInstance(EnvironmentVariables, normalised, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const message = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${message}`);
  }

  return validated;
}
