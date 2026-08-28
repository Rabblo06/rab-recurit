/**
 * Server-authoritative — never trust a client's own "is this reserved"
 * check. Built from this codebase's actual route/subdomain surface
 * (verified against `rest/v1/*` prefixes and deployment concepts), not a
 * generic example list. `workspace` is included even though it isn't a
 * literal route collision — `rest/v1/workspace` already means something
 * else (Organisation settings) and a subdomain named "workspace" would be
 * confusing regardless. Every entry gets the same "cannot be used, pick
 * another" treatment — no auto-suffixed variant is ever offered for a
 * reserved name.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'login',
  'logout',
  'www',
  'mail',
  'smtp',
  'support',
  'help',
  'status',
  'assets',
  'static',
  'cdn',
  'dashboard',
  'security',
  'settings',
  'system',
  'graphql',
  'rest',
  'healthz',
  'workspace',
]);
