import { haversineDistanceMeters } from './geo';

/**
 * Server-side evaluation of the location evidence a device sends with Check In, Clock In and Clock Out.
 * The ONE place the geofence verdict is decided (rab-server `AttendanceService` maps the error codes onto its
 * structured 409 exceptions). Venue coordinates and radius are server data; the device fix is only compared to them.
 *
 * Policy (FLAGGED owner decision, 2026-10-21):
 *  - venue does not enforce its geofence → no location is needed; anything sent is ignored (never stored, never
 *    "verified").
 *  - venue enforces its geofence:
 *      - no usable coordinates / radius on the venue → GEOFENCE_MISCONFIGURED (strict). The legacy policy (bookings made
 *        before check-in existed) keeps the old fail-soft behaviour: allowed, NOT verified.
 *      - lat/lng missing → LOCATION_REQUIRED. Strict also needs `accuracyM` and `capturedAt` (a fix without them proves
 *        nothing about where or when).
 *      - accuracy worse than min(GEOFENCE_MAX_ACCURACY_M, venue radius) → LOCATION_ACCURACY_TOO_LOW (a fix vaguer than the
 *        whole fence cannot place anyone inside it). Legacy: the global cap only.
 *      - capturedAt older than maxAgeMs, or more than maxFutureSkewMs ahead of the server, or not strictly newer than the
 *        evidence the previous step of the same booking used (`notBefore`) → LOCATION_STALE (stale or replayed fix).
 *      - great-circle distance > radius → OUTSIDE_GEOFENCE.
 */
export type LocationEvidenceErrorCode =
  | 'LOCATION_REQUIRED'
  | 'LOCATION_STALE'
  | 'LOCATION_ACCURACY_TOO_LOW'
  | 'OUTSIDE_GEOFENCE'
  | 'GEOFENCE_MISCONFIGURED';

export interface LocationEvidence {
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  capturedAt?: Date | null;
}

export interface GeofenceVenue {
  enforceGeofence: boolean;
  lat?: number | null;
  lng?: number | null;
  geofenceRadiusM?: number | null;
}

export interface LocationEvidencePolicy {
  maxAccuracyM: number;
  maxAgeMs: number;
  maxFutureSkewMs: number;
  /** false only for bookings made before Check In existed (rollout rule) — keeps their pre-existing geofence behaviour. */
  strict: boolean;
}

export type LocationEvidenceResult =
  | { ok: true; enforced: boolean; verified: boolean; distanceM: number | null; accuracyM: number | null; capturedAt: Date | null }
  | { ok: false; code: LocationEvidenceErrorCode };

export function isGeofenceConfigured(venue: GeofenceVenue): boolean {
  return (
    venue.lat != null &&
    venue.lng != null &&
    Number.isFinite(venue.lat) &&
    Number.isFinite(venue.lng) &&
    venue.geofenceRadiusM != null &&
    Number.isFinite(venue.geofenceRadiusM) &&
    venue.geofenceRadiusM > 0
  );
}

export function evaluateLocationEvidence(
  venue: GeofenceVenue,
  evidence: LocationEvidence,
  now: Date,
  policy: LocationEvidencePolicy,
  notBefore?: Date | null,
): LocationEvidenceResult {
  if (!venue.enforceGeofence) {
    return { ok: true, enforced: false, verified: false, distanceM: null, accuracyM: null, capturedAt: null };
  }
  if (!isGeofenceConfigured(venue)) {
    return policy.strict
      ? { ok: false, code: 'GEOFENCE_MISCONFIGURED' }
      : { ok: true, enforced: true, verified: false, distanceM: null, accuracyM: null, capturedAt: null };
  }
  const radius = venue.geofenceRadiusM as number;
  if (evidence.lat == null || evidence.lng == null) return { ok: false, code: 'LOCATION_REQUIRED' };
  if (policy.strict && (evidence.accuracyM == null || evidence.capturedAt == null)) return { ok: false, code: 'LOCATION_REQUIRED' };

  const accuracyCap = policy.strict ? Math.min(policy.maxAccuracyM, radius) : policy.maxAccuracyM;
  if (evidence.accuracyM != null && evidence.accuracyM > accuracyCap) return { ok: false, code: 'LOCATION_ACCURACY_TOO_LOW' };

  const capturedAt = evidence.capturedAt ?? null;
  const timing = assessCaptureTime(capturedAt, now, policy, notBefore);
  if (timing) return { ok: false, code: timing };

  const distanceM = haversineDistanceMeters({ lat: evidence.lat, lng: evidence.lng }, { lat: venue.lat as number, lng: venue.lng as number });
  if (distanceM > radius) return { ok: false, code: 'OUTSIDE_GEOFENCE' };
  return { ok: true, enforced: true, verified: true, distanceM, accuracyM: evidence.accuracyM ?? null, capturedAt };
}

/**
 * Freshness / replay of a device fix's capture time (shared by the geofence check above and the geofence-exit clock-out).
 * Absent → LOCATION_REQUIRED only under the strict policy; otherwise null (nothing to judge).
 */
export function assessCaptureTime(
  capturedAt: Date | null | undefined,
  now: Date,
  policy: Pick<LocationEvidencePolicy, 'maxAgeMs' | 'maxFutureSkewMs' | 'strict'>,
  notBefore?: Date | null,
): LocationEvidenceErrorCode | null {
  if (!capturedAt) return policy.strict ? 'LOCATION_REQUIRED' : null;
  const t = capturedAt.getTime();
  if (!Number.isFinite(t)) return 'LOCATION_STALE';
  if (t > now.getTime() + policy.maxFutureSkewMs) return 'LOCATION_STALE';
  if (now.getTime() - t > policy.maxAgeMs) return 'LOCATION_STALE';
  if (notBefore && t <= notBefore.getTime()) return 'LOCATION_STALE';
  return null;
}

/** Who/what recorded a Check In: the staff app button (`staff`) or a scan of the Shift QR (`qr`). */
export const CHECK_IN_SOURCES = ['staff', 'qr'] as const;
export type CheckInSource = (typeof CHECK_IN_SOURCES)[number];

/** How an attendance punch was made. `manager_on_behalf` = a Venue Manager live punch (reason + manager stored). */
export const CLOCK_IN_METHODS = ['staff', 'manager_on_behalf', 'manager_correction'] as const;
export type ClockInMethod = (typeof CLOCK_IN_METHODS)[number];
export const CLOCK_OUT_METHODS = ['manual', 'auto_geofence', 'manager_correction', 'manager_on_behalf'] as const;
export type ClockOutMethod = (typeof CLOCK_OUT_METHODS)[number];
