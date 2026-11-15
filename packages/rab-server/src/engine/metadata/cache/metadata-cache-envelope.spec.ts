import { randomBytes } from 'node:crypto';

import { decodeEnvelope, deriveMetadataMacKey, encodeEnvelope } from './metadata-cache-envelope';
import { WorkspaceMetadataSnapshot } from './metadata-snapshot';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const WS_A = '22222222-2222-4222-8222-222222222222';
const WS_B = '33333333-3333-4333-8333-333333333333';

const snapshot: WorkspaceMetadataSnapshot = {
  organisationId: ORG_A,
  workspaceId: WS_A,
  version: '7',
  stamp: '1700000000000001',
  objects: [{ id: 'o1', name_singular: 'rocket' }],
  fields: [{ id: 'f1', name: 'colour' }],
  fieldOptions: [],
  indexes: [],
  indexFields: [],
};

describe('metadata cache envelope (MT-11: Redis outside the trust boundary)', () => {
  const key = deriveMetadataMacKey({ key: randomBytes(32), keyId: 'derived-v1' });
  const redisKey = `crewflow:test:metadata:v1:${ORG_A}:${WS_A}:7.1700000000000001`;
  const expected = { organisationId: ORG_A, workspaceId: WS_A, version: '7', stamp: '1700000000000001' };

  it('round-trips', () => {
    const decoded = decodeEnvelope(key, redisKey, encodeEnvelope(key, redisKey, snapshot), expected);
    expect(decoded).toEqual({ ok: true, snapshot });
  });

  it('derives a sub-key: the base cache MAC key does not verify', () => {
    const base = { key: randomBytes(32), keyId: 'k' };
    const derived = deriveMetadataMacKey(base);
    expect(derived.key.equals(base.key)).toBe(false);
    expect(decodeEnvelope(base, redisKey, encodeEnvelope(derived, redisKey, snapshot), expected)).toEqual({ ok: false, reason: 'mac' });
  });

  it('rejects a tampered payload that keeps the old MAC', () => {
    const raw = JSON.parse(encodeEnvelope(key, redisKey, snapshot)) as { k: string; m: string; d: string };
    raw.d = raw.d.replace('rocket', 'pwned');
    expect(decodeEnvelope(key, redisKey, JSON.stringify(raw), expected)).toEqual({ ok: false, reason: 'mac' });
  });

  it('rejects a value forged without the key', () => {
    const forged = encodeEnvelope({ key: randomBytes(32), keyId: 'derived-v1' }, redisKey, snapshot);
    expect(decodeEnvelope(key, redisKey, forged, expected)).toEqual({ ok: false, reason: 'mac' });
  });

  it('rejects a valid value copied under another workspace key (MAC is bound to the key)', () => {
    const otherKey = `crewflow:test:metadata:v1:${ORG_A}:${WS_B}:7.1700000000000001`;
    const copied = encodeEnvelope(key, redisKey, snapshot);
    expect(decodeEnvelope(key, otherKey, copied, { ...expected, workspaceId: WS_B })).toEqual({ ok: false, reason: 'mac' });
  });

  it('rejects a payload naming another identity or version even when the MAC verifies', () => {
    const raw = encodeEnvelope(key, redisKey, snapshot);
    expect(decodeEnvelope(key, redisKey, raw, { ...expected, workspaceId: WS_B })).toEqual({ ok: false, reason: 'identity' });
    expect(decodeEnvelope(key, redisKey, raw, { ...expected, version: '8' })).toEqual({ ok: false, reason: 'identity' });
    expect(decodeEnvelope(key, redisKey, raw, { ...expected, stamp: '1700000000000002' })).toEqual({ ok: false, reason: 'identity' });
  });

  it('treats another key id as a quiet miss, and garbage as malformed', () => {
    const raw = encodeEnvelope({ ...key, keyId: 'old' }, redisKey, snapshot);
    expect(decodeEnvelope(key, redisKey, raw, expected)).toEqual({ ok: false, reason: 'key-id' });
    expect(decodeEnvelope(key, redisKey, 'not json', expected)).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeEnvelope(key, redisKey, '{"k":"derived-v1"}', expected)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a well-signed payload with the wrong shape', () => {
    const bad = { ...snapshot, fields: 'nope' } as unknown as WorkspaceMetadataSnapshot;
    expect(decodeEnvelope(key, redisKey, encodeEnvelope(key, redisKey, bad), expected)).toEqual({ ok: false, reason: 'shape' });
  });
});
