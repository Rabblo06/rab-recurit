import { evaluateLocationEvidence, isGeofenceConfigured } from './location-evidence';

describe('evaluateLocationEvidence', () => {
  const venue = { enforceGeofence: true, lat: 51.5074, lng: -0.1278, geofenceRadiusM: 150 };
  const now = new Date('2026-10-21T12:00:00Z');
  const strict = { maxAccuracyM: 100, maxAgeMs: 120_000, maxFutureSkewMs: 30_000, strict: true };
  const legacy = { ...strict, strict: false };
  const inside = { lat: 51.5075, lng: -0.1278, accuracyM: 20, capturedAt: new Date('2026-10-21T11:59:30Z') };

  it('not enforced: needs nothing and verifies nothing (ignores anything sent)', () => {
    expect(evaluateLocationEvidence({ ...venue, enforceGeofence: false }, {}, now, strict)).toEqual({
      ok: true, enforced: false, verified: false, distanceM: null, accuracyM: null, capturedAt: null,
    });
    expect(evaluateLocationEvidence({ ...venue, enforceGeofence: false }, { lat: 0, lng: 0 }, now, strict)).toMatchObject({ ok: true, verified: false });
  });

  it('enforced + inside + fresh: verified with distance and accuracy', () => {
    const r = evaluateLocationEvidence(venue, inside, now, strict);
    expect(r).toMatchObject({ ok: true, enforced: true, verified: true, accuracyM: 20 });
    expect(r.ok && r.distanceM! < 20).toBe(true);
  });

  it('misconfigured venue: strict refuses, legacy keeps the old fail-soft (not verified)', () => {
    for (const bad of [{ lat: null }, { lng: null }, { geofenceRadiusM: 0 }, { geofenceRadiusM: null }]) {
      expect(isGeofenceConfigured({ ...venue, ...bad })).toBe(false);
      expect(evaluateLocationEvidence({ ...venue, ...bad }, inside, now, strict)).toEqual({ ok: false, code: 'GEOFENCE_MISCONFIGURED' });
      expect(evaluateLocationEvidence({ ...venue, ...bad }, inside, now, legacy)).toMatchObject({ ok: true, verified: false });
    }
  });

  it('missing coordinates / accuracy / capture time', () => {
    expect(evaluateLocationEvidence(venue, {}, now, strict)).toEqual({ ok: false, code: 'LOCATION_REQUIRED' });
    expect(evaluateLocationEvidence(venue, { ...inside, accuracyM: null }, now, strict)).toEqual({ ok: false, code: 'LOCATION_REQUIRED' });
    expect(evaluateLocationEvidence(venue, { ...inside, capturedAt: null }, now, strict)).toEqual({ ok: false, code: 'LOCATION_REQUIRED' });
    // legacy: the old contract (lat/lng only) still works
    expect(evaluateLocationEvidence(venue, { lat: inside.lat, lng: inside.lng }, now, legacy)).toMatchObject({ ok: true, verified: true });
  });

  it('accuracy cap is the smaller of the global cap and the venue radius (strict)', () => {
    expect(evaluateLocationEvidence(venue, { ...inside, accuracyM: 101 }, now, strict)).toEqual({ ok: false, code: 'LOCATION_ACCURACY_TOO_LOW' });
    const small = { ...venue, geofenceRadiusM: 40 };
    expect(evaluateLocationEvidence(small, { ...inside, accuracyM: 41 }, now, strict)).toEqual({ ok: false, code: 'LOCATION_ACCURACY_TOO_LOW' });
    expect(evaluateLocationEvidence(small, { ...inside, accuracyM: 41 }, now, legacy)).toMatchObject({ ok: true });
  });

  it('stale, future and replayed fixes are refused', () => {
    expect(evaluateLocationEvidence(venue, { ...inside, capturedAt: new Date('2026-10-21T11:57:59Z') }, now, strict)).toEqual({ ok: false, code: 'LOCATION_STALE' });
    expect(evaluateLocationEvidence(venue, { ...inside, capturedAt: new Date('2026-10-21T12:00:31Z') }, now, strict)).toEqual({ ok: false, code: 'LOCATION_STALE' });
    expect(evaluateLocationEvidence(venue, { ...inside, capturedAt: new Date('invalid') }, now, strict)).toEqual({ ok: false, code: 'LOCATION_STALE' });
    // the same fix the previous step used (or an older one) is a replay
    expect(evaluateLocationEvidence(venue, inside, now, strict, inside.capturedAt)).toEqual({ ok: false, code: 'LOCATION_STALE' });
    expect(evaluateLocationEvidence(venue, inside, now, strict, new Date('2026-10-21T11:59:29Z'))).toMatchObject({ ok: true });
  });

  it('outside the radius', () => {
    expect(evaluateLocationEvidence(venue, { ...inside, lat: 51.52 }, now, strict)).toEqual({ ok: false, code: 'OUTSIDE_GEOFENCE' });
  });
});
