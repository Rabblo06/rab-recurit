/**
 * Frozen SQL shipped with migration 1786719400000 (and applied by the provisioner after the earlier V1 add-ons).
 *
 * Replacement & standby offers on the ORIGINAL shift: one NOT NULL text column on job_offer recording why the offer was
 * sent — 'standard' | 'replacement' | 'standby' (see `modules/offer/constants/offer-kind.ts`). Decided by the server at
 * send time, never by a client. DEFAULT 'standard' back-fills every existing offer as what it was: an ordinary offer.
 * A CHECK pins the value set (unknown kinds are rejected by the database, not only the service). No FK, no index, no new
 * policy: existing job_offer RLS (row-level, column-agnostic, FORCED) applies unchanged, so the structural counts in
 * `V1_EXPECTED` do not change.
 */
export function offerKindSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  const t = `${schema === 'core' ? 'core' : `"${schema}"`}.job_offer`;
  return `
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS offer_kind text NOT NULL DEFAULT 'standard';
ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS job_offer_offer_kind_check;
ALTER TABLE ${t} ADD CONSTRAINT job_offer_offer_kind_check
  CHECK (offer_kind = ANY (ARRAY['standard'::text, 'replacement'::text, 'standby'::text]));
`;
}
