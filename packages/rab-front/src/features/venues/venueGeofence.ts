/**
 * Location & Geofence form rules for the Create/Edit Venue drawer. UX only —
 * `VenueService` on the server re-validates every one of these and is the
 * authority (this exists so a Manager gets a useful message before the
 * round trip, never as a security control).
 */
export interface GeofenceFields {
  lat: string;
  lng: string;
  geofenceRadiusM: string;
  enforceGeofence: boolean;
}

export interface GeofenceErrors {
  lat?: string;
  lng?: string;
  radius?: string;
  enforce?: string;
}

/** Deliberately strict decimal syntax — rejects "NaN", "Infinity", "1e3", "0x10" that `Number()` would happily accept or coerce. */
const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^\d+$/;

const blank = (v: string) => v.trim() === '';

function coordinateError(value: string, limit: number, label: string): string | undefined {
  if (blank(value)) return undefined;
  const v = value.trim();
  if (!DECIMAL.test(v) || Math.abs(Number(v)) > limit) return `${label} must be between -${limit} and ${limit}.`;
  return undefined;
}

export function validateGeofence(f: GeofenceFields): GeofenceErrors {
  const errors: GeofenceErrors = {};
  errors.lat = coordinateError(f.lat, 90, 'Latitude');
  errors.lng = coordinateError(f.lng, 180, 'Longitude');

  // Set together or not at all — a half location can never be enforced.
  if (!errors.lat && !errors.lng) {
    if (!blank(f.lat) && blank(f.lng)) errors.lng = 'Enter the longitude as well.';
    if (blank(f.lat) && !blank(f.lng)) errors.lat = 'Enter the latitude as well.';
  }

  const radius = f.geofenceRadiusM.trim();
  if (radius !== '' && (!INTEGER.test(radius) || Number(radius) < 50)) {
    errors.radius = 'Geofence radius must be at least 50 metres.';
  } else if (radius === '' && f.enforceGeofence) {
    errors.radius = 'Geofence radius must be at least 50 metres.';
  }

  if (f.enforceGeofence && (blank(f.lat) || blank(f.lng))) {
    errors.enforce = 'Set the venue location before enabling geofence enforcement.';
  }

  return Object.fromEntries(Object.entries(errors).filter(([, v]) => v)) as GeofenceErrors;
}

/**
 * Create omits blank coordinates; Edit sends `null` for a blank one so a
 * Manager can genuinely clear a saved location (the server rejects that
 * while enforcement is on). A blank radius is always omitted — the server
 * keeps the stored/default value rather than the form inventing one.
 */
export function buildGeofencePayload(f: GeofenceFields, isEdit: boolean) {
  const coordinate = (v: string) => (blank(v) ? (isEdit ? null : undefined) : Number(v.trim()));
  return {
    lat: coordinate(f.lat),
    lng: coordinate(f.lng),
    geofenceRadiusM: blank(f.geofenceRadiusM) ? undefined : Number(f.geofenceRadiusM.trim()),
    enforceGeofence: f.enforceGeofence,
  };
}

/**
 * Google Maps' right-click "copy coordinates" gives `51.5074, -0.1278` —
 * pasting that into the Latitude box fills both fields. Pure text parsing,
 * no external service.
 */
export function parseCoordinatePair(text: string): { lat: string; lng: string } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  return m ? { lat: m[1]!, lng: m[2]! } : null;
}
