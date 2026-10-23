/**
 * FROZEN with migration EncryptedColumnEnvelopeChecks1786719960000 (kept out of the migration file: TypeORM loads every
 * export of a migration file as a migration class).
 *
 * Verified layout (engine/core-modules/secret-encryption/secret-encryption.service.ts encrypt()):
 *   "RAB2" (0x52 0x41 0x42 0x32) || kidLen (1 byte; kid is non-empty) || kid || iv (12) || authTag (16) || ciphertext (>= 0)
 * A valid value is therefore at least 4 + 1 + kidLen + 12 + 16 = 33 + kidLen bytes (34 with a one-byte kid). The CASE
 * guards get_byte() against short values (SQL does not guarantee AND short-circuiting, and get_byte past the end raises
 * instead of failing the CHECK). Plaintext, a truncated value, or a pre-RAB2 "legacy" ciphertext (iv || tag || ct, no
 * magic) is refused with 23514. RAB3 (AAD-bound) is deferred; a future envelope version needs a new migration that widens
 * this predicate BEFORE the code starts writing it.
 */
export const ENCRYPTED_COLUMNS = [
  { table: 'core."user"', column: 'totp_secret_encrypted', constraint: 'user_totp_secret_envelope_check' },
  { table: 'core.push_device', column: 'push_token_encrypted', constraint: 'push_device_push_token_envelope_check' },
  { table: 'core.platform_config', column: 'smtp_password_encrypted', constraint: 'platform_config_smtp_password_envelope_check' },
] as const;

export function rab2EnvelopePredicate(column: string): string {
  return (
    `${column} IS NULL OR CASE WHEN length(${column}) < 34 THEN false ` +
    `ELSE substring(${column} FROM 1 FOR 4) = '\\x52414232'::bytea AND get_byte(${column}, 4) >= 1 ` +
    `AND length(${column}) >= 33 + get_byte(${column}, 4) END`
  );
}
