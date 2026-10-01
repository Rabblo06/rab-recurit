/**
 * The WHATWG HTML Living Standard's own `<input type="email">` validation
 * pattern (the same one every browser already enforces natively) — not a
 * hand-rolled regex, and meaningfully stricter than `email.includes('@')`:
 * rejects a missing domain, a missing local part, or a domain with no dot
 * (`abc`, `abc@`, `abc@gmail`, `foo@bar`), while accepting real addresses
 * including multi-label domains (`first.last@example.co.uk`).
 */
const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}
