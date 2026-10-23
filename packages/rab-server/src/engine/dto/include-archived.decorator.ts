import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Wave 5 — `?includeArchived=true` on a list endpoint ("Show archived"). Archived rows are EXCLUDED by default; only
 * the literal `true`/`'true'` includes them (`'false'`, absent ⇒ excluded). Anything else (e.g. `'yes'`) is a 400, never a
 * silently-interpreted hint. It only ever widens within the caller's already-authorised scope.
 */
export function IncludeArchivedQuery(): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value)),
    IsBoolean(),
  );
}
