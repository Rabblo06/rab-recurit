import { createHmac, timingSafeEqual } from 'node:crypto';

import { isRowArray, isUuid, MetadataRow, WorkspaceMetadataSnapshot } from './metadata-snapshot';

/**
 * Metadata engine E5 — the Redis value format (MT-11, cache poisoning).
 *
 *   { k: <MAC key id>, m: hex HMAC-SHA256(key, "<redis key>\n<payload>"), d: <payload JSON> }
 *
 * The MAC binds the payload to its full Redis key, and the payload repeats organisation, workspace and version, so:
 *   - a value written by anyone who can write Redis but does not hold the MAC key is a plain miss;
 *   - a valid value copied under another workspace's (or another version's) key fails the MAC, and would also fail the
 *     identity check below;
 *   - a value under another key id (MAC key rotation) is a quiet miss.
 * Every failure is a miss that falls through to PostgreSQL; nothing here ever throws to the caller.
 *
 * Same scheme as the auth-context cache (F-06, `auth-context-cache.service.ts`), with its own derived sub-key so a MAC
 * from one cache can never verify in the other. Twenty stores a random hash next to the data with no MAC
 * (twentyhq/twenty @ eedb0a73 `engine/workspace-cache/services/workspace-cache.service.ts:615-666`); Crewflow treats
 * Redis as outside the trust boundary instead.
 */

export interface MacKey {
  key: Buffer;
  keyId: string;
}

export const METADATA_CACHE_MAC_LABEL = 'crewflow:metadata-cache:v1';

/** A purpose sub-key of the cache MAC key (HMAC as a PRF), so this cache never shares a MAC key with another. */
export function deriveMetadataMacKey(cacheMacKey: MacKey): MacKey {
  return { key: createHmac('sha256', cacheMacKey.key).update(METADATA_CACHE_MAC_LABEL).digest(), keyId: cacheMacKey.keyId };
}

function mac(key: Buffer, redisKey: string, payload: string): string {
  return createHmac('sha256', key).update(redisKey).update('\n').update(payload).digest('hex');
}

interface Payload {
  o: string;
  w: string;
  v: string;
  objects: MetadataRow[];
  fields: MetadataRow[];
  fieldOptions: MetadataRow[];
  indexes: MetadataRow[];
  indexFields: MetadataRow[];
}

export function encodeEnvelope(macKey: MacKey, redisKey: string, snapshot: WorkspaceMetadataSnapshot): string {
  const payload: Payload = {
    o: snapshot.organisationId,
    w: snapshot.workspaceId,
    v: snapshot.version,
    objects: snapshot.objects as MetadataRow[],
    fields: snapshot.fields as MetadataRow[],
    fieldOptions: snapshot.fieldOptions as MetadataRow[],
    indexes: snapshot.indexes as MetadataRow[],
    indexFields: snapshot.indexFields as MetadataRow[],
  };
  const d = JSON.stringify(payload);
  return JSON.stringify({ k: macKey.keyId, m: mac(macKey.key, redisKey, d), d });
}

export type DecodeOutcome =
  | { ok: true; snapshot: WorkspaceMetadataSnapshot }
  | { ok: false; reason: 'malformed' | 'key-id' | 'mac' | 'identity' | 'shape' };

/**
 * Verifies and decodes. `expected` is the identity the caller read from PostgreSQL for THIS request; the decoded payload
 * must name exactly the same organisation, workspace and version.
 */
export function decodeEnvelope(
  macKey: MacKey,
  redisKey: string,
  raw: string,
  expected: { organisationId: string; workspaceId: string; version: string },
): DecodeOutcome {
  let envelope: { k?: unknown; m?: unknown; d?: unknown };
  try {
    envelope = JSON.parse(raw) as typeof envelope;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!envelope || typeof envelope.d !== 'string' || typeof envelope.m !== 'string' || typeof envelope.k !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (envelope.k !== macKey.keyId) return { ok: false, reason: 'key-id' };
  const want = Buffer.from(mac(macKey.key, redisKey, envelope.d), 'hex');
  const got = Buffer.from(envelope.m, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'mac' };

  let p: Partial<Payload>;
  try {
    p = JSON.parse(envelope.d) as Partial<Payload>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!p || p.o !== expected.organisationId || p.w !== expected.workspaceId || p.v !== expected.version || !isUuid(p.o) || !isUuid(p.w)) {
    return { ok: false, reason: 'identity' };
  }
  if (!isRowArray(p.objects) || !isRowArray(p.fields) || !isRowArray(p.fieldOptions) || !isRowArray(p.indexes) || !isRowArray(p.indexFields)) {
    return { ok: false, reason: 'shape' };
  }
  return {
    ok: true,
    snapshot: {
      organisationId: p.o,
      workspaceId: p.w,
      version: p.v,
      objects: p.objects,
      fields: p.fields,
      fieldOptions: p.fieldOptions,
      indexes: p.indexes,
      indexFields: p.indexFields,
    },
  };
}
