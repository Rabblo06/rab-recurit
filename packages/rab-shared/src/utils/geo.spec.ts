import { haversineDistanceMeters, isWithinGeofence } from './geo';

describe('geo', () => {
  it('returns ~0 for the same point', () => {
    expect(haversineDistanceMeters({ lat: 51.5074, lng: -0.1278 }, { lat: 51.5074, lng: -0.1278 })).toBeCloseTo(0, 3);
  });

  it('computes a known real-world distance within a small tolerance', () => {
    // London (Trafalgar Square) to Paris (Notre-Dame) — real-world distance is ~343.5km.
    const london = { lat: 51.5080, lng: -0.1281 };
    const paris = { lat: 48.8530, lng: 2.3499 };
    const distance = haversineDistanceMeters(london, paris);
    expect(distance).toBeGreaterThan(340_000);
    expect(distance).toBeLessThan(347_000);
  });

  it('rejects NaN coordinates', () => {
    expect(() => haversineDistanceMeters({ lat: NaN, lng: 0 }, { lat: 0, lng: 0 })).toThrow(RangeError);
  });

  it('rejects Infinity coordinates', () => {
    expect(() => haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: Infinity })).toThrow(RangeError);
  });

  it('rejects out-of-range latitude', () => {
    expect(() => haversineDistanceMeters({ lat: 91, lng: 0 }, { lat: 0, lng: 0 })).toThrow(RangeError);
  });

  it('rejects out-of-range longitude', () => {
    expect(() => haversineDistanceMeters({ lat: 0, lng: -181 }, { lat: 0, lng: 0 })).toThrow(RangeError);
  });

  describe('isWithinGeofence', () => {
    const venue = { lat: 51.5074, lng: -0.1278, geofenceRadiusM: 200 };

    it('is true for the exact venue point', () => {
      expect(isWithinGeofence({ lat: 51.5074, lng: -0.1278 }, venue)).toBe(true);
    });

    it('is true for a point comfortably inside the radius', () => {
      // ~0.001 degrees latitude is roughly 111 metres.
      expect(isWithinGeofence({ lat: 51.5084, lng: -0.1278 }, venue)).toBe(true);
    });

    it('is false for a point well outside the radius', () => {
      expect(isWithinGeofence({ lat: 51.52, lng: -0.1278 }, venue)).toBe(false);
    });

    it('is inclusive exactly at the boundary', () => {
      // Construct a point at (approximately) exactly geofenceRadiusM away by
      // reusing haversineDistanceMeters itself to binary-search a matching
      // latitude offset, then assert the boundary comparison is `<=`, not `<`.
      let lo = 0;
      let hi = 0.01;
      for (let i = 0; i < 40; i += 1) {
        const mid = (lo + hi) / 2;
        const d = haversineDistanceMeters({ lat: venue.lat + mid, lng: venue.lng }, venue);
        if (d > venue.geofenceRadiusM) hi = mid;
        else lo = mid;
      }
      const boundaryPoint = { lat: venue.lat + lo, lng: venue.lng };
      expect(haversineDistanceMeters(boundaryPoint, venue)).toBeLessThanOrEqual(venue.geofenceRadiusM);
      expect(isWithinGeofence(boundaryPoint, venue)).toBe(true);
    });
  });
});
