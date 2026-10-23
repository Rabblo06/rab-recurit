/**
 * FROZEN with migration HostLabelNamespace1786719820000 (never edited after merge; additions go in a new migration that
 * INSERTs them, with a new exported constant).
 *
 * Wave 2/3 lane S2 (C2): the reserved host labels the database refuses as a workspace subdomain. Superset of
 * `@rab/shared` RESERVED_SUBDOMAINS (23 entries, lane H's file) and of Twenty's list (twenty-shared/src/constants/
 * ReservedSubdomains.ts, 121 entries in a 124-line file, inspected at /c/twenty-main 819892ab, unchanged since baseline per the phase-0
 * reference). Labels shorter than 3 characters can never be a valid subdomain (shape is 3–63) but are kept where Twenty
 * lists them, so the list stays a faithful superset and a future shape change cannot silently re-open them.
 *
 * Prefix rules (enforced in `core.host_label_is_reserved`, not rows here):
 *  - `^..--` — RFC 5891 §4.2.3.1 reserves hyphens in positions 3–4 for IDNA ("xn--" punycode is one case); blocks IDN
 *    homographs such as an "xn--" label that renders like "crewflow";
 *  - `api-`, `www-` — Twenty's SUBDOMAIN_PATTERN refuses `api-`; `www-` is the same class of look-alike;
 *  - `crewflow-` — brand impersonation ("crewflow-support", "crewflow-billing").
 *
 * Categories and why each addition beyond the two source lists is here:
 *  - INFRASTRUCTURE: DNS/mail/hosting names a tenant must never hold. Added: ftp, ns1, ns2, mx, email, imap, pop, pop3,
 *    webmail, autodiscover, autoconfig (mail clients auto-configure from these hosts — a tenant holding them could harvest
 *    credentials), mta-sts (holding it lets a tenant publish the domain's mail TLS policy), localhost, internal, intranet,
 *    vpn, preview, qa, m, mobile, ws, wss, socket, realtime, push, webhook, webhooks, hooks, uploads, download, downloads,
 *    worker, queue, redis, postgres, grafana, prometheus, monitoring, sentry.
 *  - IDENTITY: auth and account surfaces (phishing look-alikes on a sibling host would inherit trust). Added: accounts,
 *    account, sso, oauth, id, identity, my, secure, password, reset, verify, root, administrator, sysadmin, superuser.
 *  - PRODUCT: Crewflow surfaces and the words that make an official-looking payroll/pay phishing page. Added (phase-0
 *    proposal + product nouns): crewflow-adjacent console, portal, platform, tenant, tenants, workspaces, organisation,
 *    organization, manager, managers, staff, venue, venues, payroll, payslip, payslips, timesheet, timesheets, invoice,
 *    invoices, pay, payments.
 *  - BRAND: crewflow, adolphus, rab.
 *  - TWENTY_PARITY: entries that come only from Twenty's list.
 */
export type ReservedHostLabelCategory = 'INFRASTRUCTURE' | 'IDENTITY' | 'PRODUCT' | 'BRAND' | 'TWENTY_PARITY';

const INFRASTRUCTURE = [
  'api', 'app', 'assets', 'autoconfig', 'autodiscover', 'cdn', 'demo', 'dev', 'docs', 'download', 'downloads', 'email', 'ftp',
  'grafana', 'graphql', 'healthz', 'hooks', 'imap', 'internal', 'intranet', 'localhost', 'm', 'mail', 'mobile', 'monitoring',
  'mta-sts', 'mx', 'ns1', 'ns2', 'pop', 'pop3', 'postgres', 'preview', 'prometheus', 'push', 'qa', 'queue', 'realtime', 'redis',
  'rest', 'sentry', 'smtp', 'socket', 'staging', 'static', 'status', 'system', 'test', 'uploads', 'vpn', 'webhook', 'webhooks',
  'webmail', 'worker', 'ws', 'wss', 'www', 'blog',
] as const;

const IDENTITY = [
  'account', 'accounts', 'admin', 'administrator', 'auth', 'id', 'identity', 'login', 'logout', 'my', 'oauth', 'password',
  'reset', 'root', 'secure', 'security', 'sso', 'superuser', 'sysadmin', 'verify',
] as const;

const PRODUCT = [
  'billing', 'console', 'dashboard', 'help', 'invoice', 'invoices', 'manager', 'managers', 'organisation', 'organization', 'pay',
  'payments', 'payroll', 'payslip', 'payslips', 'platform', 'portal', 'settings', 'staff', 'support', 'tenant', 'tenants',
  'timesheet', 'timesheets', 'venue', 'venues', 'workspace', 'workspaces',
] as const;

const BRAND = ['adolphus', 'crewflow', 'rab'] as const;

/** Twenty's RESERVED_SUBDOMAINS, verbatim (121 entries). */
export const TWENTY_RESERVED_SUBDOMAINS = [
  'about', 'admin', 'africa', 'al', 'america', 'api', 'app', 'asia', 'assets', 'au', 'audio', 'auth', 'az', 'ba', 'be', 'bg',
  'billing', 'blog', 'ca', 'careers', 'cdn', 'ch', 'chat', 'community', 'companies', 'config', 'contact', 'cy', 'cz', 'dash',
  'dashboard', 'db', 'de', 'demo', 'dev', 'developer', 'dk', 'docs', 'ee', 'es', 'eu', 'europe', 'events', 'favicon', 'feedback',
  'fi', 'files', 'forum', 'fr', 'gr', 'help', 'hr', 'hu', 'image', 'images', 'is', 'it', 'jobs', 'legal', 'login', 'logs',
  'london', 'lt', 'lv', 'mail', 'main', 'me', 'media', 'merch', 'metrics', 'mk', 'new-york', 'news', 'next', 'nl', 'no',
  'north-africa', 'north-america', 'nz', 'oceania', 'otel-collector', 'paris', 'partners', 'partnership', 'partnerships',
  'payment', 'pl', 'privacy', 'production', 'pt', 'register', 'ro', 'rs', 'ru', 'san-francisco', 'se', 'settings', 'shop', 'si',
  'signin', 'signup', 'sk', 'south-africa', 'south-america', 'staging', 'storage', 'store', 'support', 't', 'telemetry', 'terms',
  'test', 'testing', 'tr', 'trust', 'ua', 'uk', 'us', 'video', 'www', 'za',
] as const;

/** `@rab/shared` RESERVED_SUBDOMAINS at the time of the migration (all are also in the lists above). */
export const RAB_SHARED_RESERVED_SUBDOMAINS_AT_MIGRATION = [
  'admin', 'api', 'app', 'auth', 'login', 'logout', 'www', 'mail', 'smtp', 'support', 'help', 'status', 'assets', 'static', 'cdn',
  'dashboard', 'security', 'settings', 'system', 'graphql', 'rest', 'healthz', 'workspace',
] as const;

/** One row per label; the first category that lists it wins (Crewflow categories before Twenty parity). */
export const HOST_LABEL_RESERVED_SEED: ReadonlyArray<{ label: string; category: ReservedHostLabelCategory }> = (() => {
  const seen = new Map<string, ReservedHostLabelCategory>();
  const add = (labels: readonly string[], category: ReservedHostLabelCategory) => {
    for (const l of labels) if (!seen.has(l)) seen.set(l, category);
  };
  add(BRAND, 'BRAND');
  add(IDENTITY, 'IDENTITY');
  add(INFRASTRUCTURE, 'INFRASTRUCTURE');
  add(PRODUCT, 'PRODUCT');
  add(TWENTY_RESERVED_SUBDOMAINS, 'TWENTY_PARITY');
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, category]) => ({ label, category }));
})();

/** Prefixes refused regardless of the table (see the header). Mirrored in SQL by core.host_label_is_reserved. */
export const HOST_LABEL_RESERVED_PREFIX_PATTERN = '^(..--|api-|www-|crewflow-)';
