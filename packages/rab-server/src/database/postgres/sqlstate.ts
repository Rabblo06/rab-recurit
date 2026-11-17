/**
 * PostgreSQL 18 reports a violated `ON DELETE / ON UPDATE RESTRICT` foreign key as SQLSTATE 23001 (restrict_violation)
 * instead of 23503 (foreign_key_violation); NO ACTION keys still report 23503 (PostgreSQL 18 release notes, "Migration to
 * Version 18"). Code that means "a row still references this" must accept both, or on 18 it treats the refusal as an
 * unexpected error (crewflow's RESTRICT keys: payroll evidence, several core."user" references).
 */
export const FOREIGN_KEY_REFUSAL_SQLSTATES: readonly string[] = Object.freeze(['23503', '23001']);

/** True for 23503 (foreign_key_violation) and, on PostgreSQL 18, 23001 (restrict_violation). */
export function isForeignKeyRefusal(code: unknown): boolean {
  return typeof code === 'string' && FOREIGN_KEY_REFUSAL_SQLSTATES.includes(code);
}
