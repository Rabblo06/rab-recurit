import { randomBytes } from 'node:crypto';

import { parseKeyringEnvVar, RawKeyringEntry, weakKeyMaterialReason } from '../engine/core-modules/secret-encryption/keyring.util';

/**
 * Wave 2 lane A2 — JWT signing-key rotation helper (no database, no Nest). It only computes the NEXT value of
 * APP_JWT_SIGNING_KEYRING; an operator puts that value into the secret store and redeploys. Rotation runbook
 * (WAVE2_LANE_A2_REPORT.md §3):
 *   1. `add <kid>`     → deploy the printed keyring with APP_JWT_ACTIVE_KID UNCHANGED (new kid verify-only).
 *                        Confirm every API instance reports the new kid: `secret:rotate --check-keyring`.
 *   2. flip            → set APP_JWT_ACTIVE_KID=<kid>, redeploy. Old kid still verifies.
 *   3. wait            → at least one access-token TTL (15 min) plus clock skew after the LAST instance flipped.
 *   4. `retire <old>`  → deploy the printed keyring without the old kid.
 * No step invalidates a live token: refresh tokens are opaque DB rows, and every access token in flight was signed by a
 * kid still present when it is verified.
 *
 *   node dist/command/jwt-keyring-plan.js add <kid>
 *   node dist/command/jwt-keyring-plan.js retire <kid>
 *
 * Reads APP_JWT_SIGNING_KEYRING / APP_JWT_ACTIVE_KID from the environment. The printed keyring contains key material:
 * paste it into the secret store only, never into a ticket, log or chat.
 */
const RESERVED_KIDS = new Set(['legacy', 'derived-v1']);
const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function planAddKid(currentRaw: string | undefined, newKid: string, secret = randomBytes(48).toString('base64url')): RawKeyringEntry[] {
  if (!KID_PATTERN.test(newKid)) throw new Error('kid must be 1-64 characters of A-Z a-z 0-9 . _ - (starting with a letter or digit).');
  if (RESERVED_KIDS.has(newKid)) throw new Error(`kid "${newKid}" is reserved.`);
  const reason = weakKeyMaterialReason(secret);
  if (reason) throw new Error(`the new secret ${reason}.`);
  const current = currentRaw ? parseKeyringEnvVar(currentRaw, 'APP_JWT_SIGNING_KEYRING') : [];
  if (current.some((entry) => entry.kid === newKid)) throw new Error(`kid "${newKid}" already exists in APP_JWT_SIGNING_KEYRING.`);
  return [...current, { kid: newKid, secret }];
}

export function planRetireKid(currentRaw: string | undefined, activeKid: string | undefined, retiredKid: string): RawKeyringEntry[] {
  if (!currentRaw) throw new Error('APP_JWT_SIGNING_KEYRING is not set — nothing to retire.');
  const current = parseKeyringEnvVar(currentRaw, 'APP_JWT_SIGNING_KEYRING');
  if (!current.some((entry) => entry.kid === retiredKid)) throw new Error(`kid "${retiredKid}" is not in APP_JWT_SIGNING_KEYRING.`);
  if (retiredKid === activeKid) throw new Error(`kid "${retiredKid}" is APP_JWT_ACTIVE_KID — flip the active kid first.`);
  return current.filter((entry) => entry.kid !== retiredKid);
}

function main(argv: string[]): number {
  const [action, kid] = argv;
  const raw = process.env.APP_JWT_SIGNING_KEYRING || undefined;
  const active = process.env.APP_JWT_ACTIVE_KID || undefined;
  /* eslint-disable no-console */
  try {
    if (action === 'add' && kid) {
      const next = planAddKid(raw, kid);
      console.log(`# Step 1: deploy this APP_JWT_SIGNING_KEYRING with APP_JWT_ACTIVE_KID unchanged (${active ?? 'derived-v1 (no keyring yet)'}).`);
      console.log(`# Step 2 (after every instance lists "${kid}"): set APP_JWT_ACTIVE_KID=${kid}.`);
      console.log('# Contains key material: secret store only.');
      console.log(JSON.stringify(next));
      return 0;
    }
    if (action === 'retire' && kid) {
      const next = planRetireKid(raw, active, kid);
      console.log(`# Deploy only once ${kid} has not signed anything for at least 15 minutes (one access-token TTL) plus clock skew.`);
      console.log('# Contains key material: secret store only.');
      console.log(JSON.stringify(next));
      return 0;
    }
    console.error('usage: jwt-keyring-plan add <kid> | retire <kid>');
    return 2;
  } catch (error) {
    console.error(`refused: ${(error as Error).message}`);
    return 1;
  }
  /* eslint-enable no-console */
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
