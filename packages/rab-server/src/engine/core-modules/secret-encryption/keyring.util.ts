import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Wave 2 lane A2 — key separation. One place that knows how every server key is derived and how keyring env vars are
 * parsed, so `AccessTokenService`, `SecretEncryptionService`, `AuthContextCacheService` and boot validation
 * (`env.validation.ts`) can never disagree.
 *
 * Purposes and their roots (see WAVE2_LANE_A2_REPORT.md §2):
 *   - `jwt-access`      APP_JWT_SIGNING_KEYRING entries (dedicated secrets, used as the HS256 key as before so tokens
 *                       already issued under an existing kid keep verifying), or — with no keyring — the HKDF-derived
 *                       default kid `derived-v1`. Raw APP_SECRET (`legacy` kid) is verify-only behind
 *                       APP_JWT_LEGACY_VERIFY_ENABLED.
 *   - `auth-cache-hmac` APP_AUTH_CACHE_HMAC_KEY (dedicated), or HKDF-derived from APP_SECRET. Rotation only costs cache misses.
 *   - encryption        APP_ENCRYPTION_KEYRING (unchanged derivation `rab-secret-encryption:<kid>`; legacy
 *                       `rab-secret-encryption` from APP_SECRET for existing ciphertext).
 *   - QR tokens         HKDF(APP_SECRET, 'rab-qr-token-v1') in modules/attendance — unchanged (printed QR codes).
 *
 * Primitives: node:crypto HKDF-SHA256 (RFC 5869) and HMAC-SHA256 only. The `info` label carries the purpose AND the kid,
 * so two purposes (or two kids) never derive the same key from the same input, and a key for one purpose reveals nothing
 * about another or about the input secret.
 */
export type KeyPurpose = 'jwt-access' | 'auth-cache-hmac';

export const KEY_PURPOSE_LABEL_PREFIX = 'crewflow:key-purpose:v1';
const DERIVED_KEY_LENGTH = 32;

export function derivePurposeKey(inputKeyMaterial: string, purpose: KeyPurpose, kid: string): Buffer {
  if (!kid) throw new Error('derivePurposeKey: kid must not be empty.');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(inputKeyMaterial, 'utf8'), Buffer.alloc(0), `${KEY_PURPOSE_LABEL_PREFIX}:${purpose}:${kid}`, DERIVED_KEY_LENGTH),
  );
}

/** Non-secret identifier for a derived key (HMAC of a fixed label under the key — reveals nothing about the key). */
export function keyFingerprint(key: Buffer): string {
  return createHmac('sha256', key).update(`${KEY_PURPOSE_LABEL_PREFIX}:fingerprint`).digest('hex').slice(0, 12);
}

/** The auth-context cache MAC key and the id stored next to each entry (an entry under another key id is a quiet miss). */
export function resolveAuthCacheMacKey(appSecret: string, dedicatedKey: string | undefined): { key: Buffer; keyId: string } {
  if (dedicatedKey) {
    const key = derivePurposeKey(dedicatedKey, 'auth-cache-hmac', 'dedicated');
    return { key, keyId: `d-${keyFingerprint(key)}` };
  }
  return { key: derivePurposeKey(appSecret, 'auth-cache-hmac', 'derived-v1'), keyId: 'derived-v1' };
}

export interface RawKeyringEntry {
  kid: string;
  secret: string;
}

/** Shared parser for APP_ENCRYPTION_KEYRING / APP_JWT_SIGNING_KEYRING. Throws (fail closed) on any malformed entry or duplicate kid. */
export function parseKeyringEnvVar(raw: string, varName: string): RawKeyringEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${varName} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${varName} must be a JSON array.`);
  }
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { kid?: unknown }).kid !== 'string' ||
      typeof (entry as { secret?: unknown }).secret !== 'string'
    ) {
      throw new Error(`${varName}[${index}] must be an object with string "kid" and "secret" fields.`);
    }
    const { kid, secret } = entry as { kid: string; secret: string };
    if (!kid) {
      throw new Error(`${varName}[${index}].kid must not be empty.`);
    }
    if (seen.has(kid)) {
      throw new Error(`${varName} defines kid "${kid}" more than once.`);
    }
    seen.add(kid);
    if (secret.length < 32) {
      throw new Error(`${varName}[${index}].secret ("${kid}") must be at least 32 characters.`);
    }
    return { kid, secret };
  });
}

const PLACEHOLDER_PATTERN = /change[-_ ]?me|replace[-_ ]?me|placeholder|example|your[-_ ]?(app[-_ ]?)?secret|insecure|do[-_ ]?not[-_ ]?use/i;
const MIN_DISTINCT_CHARACTERS = 8;

/**
 * Why a secret is too weak for production, or null. Deliberately narrow (no false positives on real random keys): at
 * least 32 characters, at least 8 distinct characters (`'x'.repeat(40)` fails, any `openssl rand -hex 32` passes), and
 * no obvious placeholder wording. Never echoes the value.
 */
export function weakKeyMaterialReason(value: string): string | null {
  if (value.length < 32) return 'is shorter than 32 characters';
  if (new Set(value).size < MIN_DISTINCT_CHARACTERS) return `has fewer than ${MIN_DISTINCT_CHARACTERS} distinct characters`;
  if (PLACEHOLDER_PATTERN.test(value)) return 'looks like a placeholder value';
  return null;
}

export interface KeyMaterialConfig {
  NODE_ENV?: string;
  APP_SECRET?: string;
  APP_JWT_SIGNING_KEYRING?: string;
  APP_JWT_ACTIVE_KID?: string;
  APP_ENCRYPTION_KEYRING?: string;
  APP_AUTH_CACHE_HMAC_KEY?: string;
  APP_JWT_LEGACY_VERIFY_ENABLED?: boolean;
  APP_KEY_SEPARATION_REQUIRED?: boolean;
}

/** Every configured secret with a human label (names only). Unparseable keyrings are reported, not thrown. */
function collectKeyRoles(config: KeyMaterialConfig, problems: string[]): Array<{ label: string; secret: string }> {
  const roles: Array<{ label: string; secret: string }> = [];
  if (config.APP_SECRET) roles.push({ label: 'APP_SECRET', secret: config.APP_SECRET });
  for (const varName of ['APP_JWT_SIGNING_KEYRING', 'APP_ENCRYPTION_KEYRING'] as const) {
    const raw = config[varName];
    if (!raw) continue;
    try {
      for (const entry of parseKeyringEnvVar(raw, varName)) roles.push({ label: `${varName} kid "${entry.kid}"`, secret: entry.secret });
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (config.APP_AUTH_CACHE_HMAC_KEY) roles.push({ label: 'APP_AUTH_CACHE_HMAC_KEY', secret: config.APP_AUTH_CACHE_HMAC_KEY });
  return roles;
}

/**
 * Boot-time key checks for EVERY environment (env.validation.ts). Names only, never values.
 *   - keyrings parse (malformed JSON, duplicate kid, short secret);
 *   - APP_AUTH_CACHE_HMAC_KEY is 32+ characters;
 *   - no secret is shared between two roles (APP_SECRET, a JWT kid, an encryption kid, the cache MAC key) — sharing would
 *     make "separate keys" a rename;
 *   - APP_KEY_SEPARATION_REQUIRED=true: a dedicated JWT keyring, APP_JWT_LEGACY_VERIFY_ENABLED=false and a dedicated
 *     APP_AUTH_CACHE_HMAC_KEY are all required — APP_SECRET is then no root of any JWT or cache-MAC key.
 */
export function keyMaterialProblems(config: KeyMaterialConfig): string[] {
  const problems: string[] = [];
  const roles = collectKeyRoles(config, problems);
  if (config.APP_AUTH_CACHE_HMAC_KEY && config.APP_AUTH_CACHE_HMAC_KEY.length < 32) problems.push('APP_AUTH_CACHE_HMAC_KEY must be at least 32 characters.');

  for (let i = 0; i < roles.length; i += 1) {
    for (let j = i + 1; j < roles.length; j += 1) {
      if (roles[i].secret === roles[j].secret) problems.push(`${roles[i].label} and ${roles[j].label} use the same secret. Every key role needs its own secret.`);
    }
  }

  if (config.APP_KEY_SEPARATION_REQUIRED === true) {
    if (!config.APP_JWT_SIGNING_KEYRING || !config.APP_JWT_ACTIVE_KID) problems.push('APP_KEY_SEPARATION_REQUIRED=true requires APP_JWT_SIGNING_KEYRING and APP_JWT_ACTIVE_KID.');
    if (config.APP_JWT_LEGACY_VERIFY_ENABLED !== false) problems.push('APP_KEY_SEPARATION_REQUIRED=true requires APP_JWT_LEGACY_VERIFY_ENABLED=false.');
    if (!config.APP_AUTH_CACHE_HMAC_KEY) problems.push('APP_KEY_SEPARATION_REQUIRED=true requires APP_AUTH_CACHE_HMAC_KEY.');
  }
  return problems;
}

/** Production only (folded into productionConfigurationProblems): every configured secret passes `weakKeyMaterialReason`. */
export function productionKeyMaterialProblems(config: KeyMaterialConfig): string[] {
  const roles = collectKeyRoles(config, []);
  const problems: string[] = [];
  for (const role of roles) {
    const reason = weakKeyMaterialReason(role.secret);
    if (reason) problems.push(`${role.label} ${reason}. Generate a new one with: openssl rand -base64 48`);
  }
  return problems;
}
