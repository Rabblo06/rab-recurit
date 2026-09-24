/**
 * The ONE place `STORAGE_KEY_PREFIX` (e.g. `production`, `staging`, `dev`) is
 * turned into the literal string every object key starts with. Every caller
 * that builds a key goes through this — never `env.get('STORAGE_KEY_PREFIX')`
 * concatenated inline — so `production`, `production/`, ` /production/ ` and
 * `/production` all produce the identical, canonical `production/`, and a
 * prefix can never introduce a double slash or a path-traversal segment into
 * every object key this application will ever write.
 */
export function normaliseKeyPrefix(rawPrefix: string): string {
  const trimmed = rawPrefix.trim();
  // Collapse repeated separators, drop leading/trailing ones, then reject any
  // remaining traversal segment outright — a prefix is operator config, not
  // trusted to be well-formed, and a `../` here would let it climb out of
  // every organisation's own key namespace.
  const segments = trimmed
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Invalid STORAGE_KEY_PREFIX "${rawPrefix}": traversal segments are not allowed.`);
  }
  if (segments.length === 0) {
    throw new Error('STORAGE_KEY_PREFIX must not be empty or entirely separators.');
  }
  return `${segments.join('/')}/`;
}
