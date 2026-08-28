const MIN_SUBDOMAIN_LENGTH = 3;
const MAX_SUBDOMAIN_LENGTH = 63;

/**
 * lowercase -> trim -> whitespace/unsupported chars -> hyphen -> collapse
 * repeated hyphens -> strip leading/trailing hyphen -> clamp length. One
 * shared implementation for both the web onboarding UI's live preview and
 * the backend's authoritative check — never duplicated, since the two
 * disagreeing is exactly the kind of drift `SubdomainService` exists to
 * prevent (the DB is still the final authority on uniqueness; this is only
 * the shape transform).
 */
export function normalizeSubdomain(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SUBDOMAIN_LENGTH)
    .replace(/-+$/g, '');
}

/** Same shape `UpdateSubdomainDto` already validates: 3-63 lowercase letters/numbers/hyphens, no leading/trailing hyphen. */
export function isValidSubdomainShape(candidate: string): boolean {
  if (candidate.length < MIN_SUBDOMAIN_LENGTH || candidate.length > MAX_SUBDOMAIN_LENGTH) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(candidate);
}
