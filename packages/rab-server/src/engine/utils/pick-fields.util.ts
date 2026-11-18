/**
 * SF-7 — the explicit field map CLAUDE.md requires for entity writes ("never spread a client object into an entity
 * update; map allowed fields explicitly").
 *
 * Returns a NEW object holding only the keys named in `fields`, and only those whose value is not `undefined` (`null` is
 * kept: it is how a nullable field is cleared). Every other key on `source` (`organisationId`, `createdBy`, `status`,
 * an id, or any key a direct caller added) is never copied. The global ValidationPipe's `forbidNonWhitelisted` rejects
 * undeclared fields for HTTP callers only; jobs, CLI commands and other services call the services directly, so the
 * service itself must not trust the shape of the object it is handed.
 *
 * Call sites declare their allow-list with `as const satisfies readonly (keyof Dto & keyof Entity)[]`, so a field that
 * is not on both the DTO and the entity is a compile error.
 */
export function pickFields<T extends object, K extends keyof T>(source: T, fields: readonly K[]): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}
