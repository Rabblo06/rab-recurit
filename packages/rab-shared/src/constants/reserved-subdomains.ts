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
  // Wave 3 lane H (phase 0 C2): operational and Crewflow-specific hosts that must never be a workspace, because they
  // are (or may become) platform hosts serving other code. Mirrors S2's database-enforced list; the database is the
  // final authority, this copy only gives the UI and the host resolver the same answer without a round trip.
  'accounts',
  'account',
  'crewflow',
  'rab',
  'venue',
  'venues',
  'staff',
  'payroll',
  'portal',
  'console',
  'webhooks',
  'webhook',
  'ns1',
  'ns2',
  'mx',
  'email',
  'docs',
  'blog',
  'billing',
  'dev',
  'staging',
  'test',
  'demo',
  'internal',
  'localhost',
]);

/**
 * Prefixes that make any label reserved, mirroring lane S2's `core.host_label_is_reserved` (`^(..--|api-|www-|crewflow-)`):
 * `api-`, `www-` (look like platform hosts) and `crewflow-` (brand impersonation). The `..--` rule (hyphens in positions
 * 3-4, RFC 5891 — `xn--` punycode/IDN homographs) is applied separately by `isReservedSubdomainLabel`.
 * This TS list is a SUBSET of the database's seed (`host-label-reserved-list.ts`); the database stays the authority.
 */
export const RESERVED_SUBDOMAIN_PREFIXES: readonly string[] = ['xn--', 'api-', 'www-', 'crewflow-'];
