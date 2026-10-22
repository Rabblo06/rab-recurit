import 'package:geolocator/geolocator.dart';

/// Thin wrapper around `geolocator` for the one-shot "where am I right now"
/// check used before Clock In/Out — never a throw on denial/timeout, only
/// `null`, so callers show a calm permission/unavailable UI instead of an
/// uncaught exception. Background streaming (geofence-exit monitoring) is a
/// separate concern, started directly against `Geolocator.getPositionStream`
/// by `AttendanceProvider`, not through this one-shot helper.
class LocationService {
  /// `null` means: permission denied, service disabled, or the device
  /// couldn't get a fix in time — never distinguishes further here, since
  /// every one of those cases leads to the same "we need your location"
  /// dialog. Backend independently validates accuracy/geofence regardless of
  /// what this reports, per CLAUDE.md's "never trust the client" rule.
  Future<Position?> getCurrentPosition() async {
    if (!await Geolocator.isLocationServiceEnabled()) return null;

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      return null;
    }

    try {
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 20),
        ),
      );
    } catch (_) {
      return null;
    }
  }

  /// Whether the OS-level permission is currently denied outright (not
  /// merely "not yet asked") — used to decide between the explain-first
  /// permission sheet and the "open Settings" unavailable dialog.
  Future<bool> isPermanentlyDenied() async =>
      await Geolocator.checkPermission() == LocationPermission.deniedForever;

  Future<bool> requestBackgroundPermission() async {
    final permission = await Geolocator.requestPermission();
    return permission == LocationPermission.always;
  }
}

/// One device fix as sent with Check In / Clock In / Clock Out / geofence
/// exit: `lat`, `lng`, `accuracyM` and `capturedAt` (ISO-8601 with offset).
/// The server judges freshness, accuracy and the geofence; nothing here is
/// ever used as an attendance time.
class LocationFix {
  const LocationFix({
    required this.lat,
    required this.lng,
    required this.accuracyM,
    required this.capturedAt,
  });

  /// [trustedNow] is the server-anchored clock (`AttendanceProvider.
  /// trustedNow`). The fix's age is measured on the device's monotonic-ish
  /// wall clock (both ends of the subtraction use it, so a wrong device clock
  /// cancels out) and then placed on the server's timeline, so a phone whose
  /// clock is minutes off does not have every fix refused as stale. Without
  /// a server anchor the device time is used as-is.
  factory LocationFix.fromPosition(
    Position position, {
    DateTime? trustedNow,
    DateTime? deviceNow,
  }) {
    final device = deviceNow ?? DateTime.now();
    var age = device.difference(position.timestamp);
    if (age.isNegative) age = Duration.zero;
    return LocationFix(
      lat: position.latitude,
      lng: position.longitude,
      accuracyM: position.accuracy,
      capturedAt: (trustedNow ?? device).subtract(age),
    );
  }

  final double lat, lng, accuracyM;
  final DateTime capturedAt;

  Map<String, Object> toJson() => {
    'lat': lat,
    'lng': lng,
    'accuracyM': accuracyM,
    // Always UTC with the `Z` offset: the server refuses wall-clock times.
    'capturedAt': capturedAt.toUtc().toIso8601String(),
  };
}
