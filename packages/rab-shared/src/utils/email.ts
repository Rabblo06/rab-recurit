/**
 * The one shared identity-lookup normalization used everywhere an email is
 * looked up, compared, or stored for account-identity purposes (Manager/Staff
 * creation, login, invitation issue/resend, change-pending-email,
 * forgot-password, duplicate checks). Deliberately NOT Gmail-style alias
 * normalization (no dot-removal, no +suffix stripping) — those change what
 * mailbox a message reaches, which is a delivery concern, not an identity
 * one. `core.user.email` is already `citext` (case-insensitive at the DB
 * layer); this trims stray whitespace too, so display/comparison/storage
 * agree even where a raw string comparison (not a citext column) is used.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
