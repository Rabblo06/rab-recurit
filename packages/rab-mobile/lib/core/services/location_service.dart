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
