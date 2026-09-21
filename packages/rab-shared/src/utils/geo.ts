/**
 * Server-side venue geofence check. `Venue.lat`/`Venue.lng`/`Venue.geofenceRadiusM`
 * are server-controlled data (`modules/venue/entities/venue.entity.ts`); a
 * device's own reported coordinates are never trusted for venue identity —
 * this is the one place "is the device inside the venue" is computed, reused
 * by `AttendanceService.clockIn`/`clockOut`/`autoClockOutOnGeofenceExit`
 * (never a second, drifted implementation).
 */

const EARTH_RADIUS_METERS = 6_371_000;

export interface GeoPoint {
  lat: number;
  lng: number;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function assertFiniteCoordinate(point: GeoPoint): void {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    throw new RangeError('Coordinates must be finite numbers, not NaN/Infinity.');
  }
  if (point.lat < -90 || point.lat > 90) {
    throw new RangeError('Latitude must be between -90 and 90.');
  }
  if (point.lng < -180 || point.lng > 180) {
    throw new RangeError('Longitude must be between -180 and 180.');
  }
}

/** Great-circle distance between two points, in metres — the standard haversine formula. */
export function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  assertFiniteCoordinate(a);
  assertFiniteCoordinate(b);

  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_METERS * c;
}

/** `true` when `point` is within `venue.geofenceRadiusM` metres of the venue's trusted coordinates — inclusive at the boundary. */
export function isWithinGeofence(point: GeoPoint, venue: { lat: number; lng: number; geofenceRadiusM: number }): boolean {
  return haversineDistanceMeters(point, { lat: venue.lat, lng: venue.lng }) <= venue.geofenceRadiusM;
}
