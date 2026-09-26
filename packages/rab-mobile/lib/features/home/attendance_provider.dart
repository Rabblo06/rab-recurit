import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

import '../../core/api/api_client.dart';
import '../../core/models/attendance.dart';

/// Real Clock In/Out state — every timestamp displayed comes from the
/// backend's own `clockInAt`/`clockOutAt`/`workedMinutes`/`earnedPence`,
/// never computed or guessed client-side. `active` is restored from `GET
/// /attendance/me/active` on construction (and whenever `refreshActive()` is
/// called, e.g. on app resume) — this is what makes the live timer survive
/// an app kill/reopen without resetting to `00:00:00`.
class AttendanceProvider extends ChangeNotifier {
  AttendanceProvider(this._api) {
    refreshActive();
  }

  final ApiClient _api;

  AttendanceSummary? active;
  List<AttendanceSummary> history = [];
  bool isLoadingActive = true;
  bool isLoadingHistory = false;
  bool isBusy = false;
  String? errorMessage;
  String? errorCode;
  String? activeLoadError;
  String? historyLoadError;

  /// The backend's clock at the moment `GET /attendance/me/active` last
  /// responded — the mobile timer and any "clock-in opens at..." countdown
  /// must always anchor to this, never `DateTime.now()` (CLAUDE.md: never
  /// trust the device clock). `null` until the first successful load.
  DateTime? serverNow;
  final Stopwatch _sinceServerTime = Stopwatch();
  DateTime? get trustedNow => serverNow?.add(_sinceServerTime.elapsed);

  StreamSubscription<Position>? _geofenceSub;

  Future<void> refreshActive() async {
    isLoadingActive = true;
    notifyListeners();
    try {
      final data =
          await _api.get('/attendance/me/active') as Map<String, dynamic>;
      final attendanceJson = data['attendance'] as Map<String, dynamic>?;
      active = attendanceJson == null
          ? null
          : AttendanceSummary.fromJson(attendanceJson);
      final serverNowRaw = data['serverNow'] as String?;
      if (serverNowRaw != null) {
        serverNow = DateTime.parse(serverNowRaw);
        _sinceServerTime
          ..reset()
          ..start();
      }
      activeLoadError = null;
      // Restores geofence monitoring across an app kill/reopen while a
      // shift is still live — mirrors how the timer itself survives restart
      // by re-deriving from the server rather than local state.
      if (active != null) {
        startGeofenceMonitoring();
      } else {
        stopGeofenceMonitoring();
      }
    } catch (_) {
      activeLoadError = 'Could not check attendance. Please try again.';
      // A failed restore leaves `active` as-is rather than clearing a
      // possibly-still-valid state on a transient network error.
    } finally {
      isLoadingActive = false;
      notifyListeners();
    }
  }

  Future<void> loadHistory() async {
    isLoadingHistory = true;
    notifyListeners();
    try {
      final data = await _api.get('/attendance/me/history') as List<dynamic>;
      history = data
          .map((e) => AttendanceSummary.fromJson(e as Map<String, dynamic>))
          .toList();
      historyLoadError = null;
    } catch (_) {
      historyLoadError = 'Could not check completed shifts. Please try again.';
      // Leave the previous list in place on a transient failure.
    } finally {
      isLoadingHistory = false;
      notifyListeners();
    }
  }

  /// Only ever reflects success after the backend confirms — no optimistic
  /// "clocked in" state before the response lands, so a network failure
  /// never shows a clock-in that didn't actually happen. `qrToken` is
  /// required (the backend rejects a clock-in without one); `lat`/`lng`/
  /// `accuracyM` are optional only in the sense that a venue without
  /// geofencing enabled doesn't need them — the caller (`schedule_clock_
  /// screen.dart`) always tries to get a fix first regardless.
  Future<bool> clockIn(
    String shiftId, {
    required String qrToken,
    double? lat,
    double? lng,
    double? accuracyM,
  }) async {
    if (isBusy) return false;
    isBusy = true;
    errorMessage = null;
    errorCode = null;
    notifyListeners();
    try {
      final data =
          await _api.post(
                '/attendance/clock-in',
                body: {
                  'shiftId': shiftId,
                  'qrToken': qrToken,
                  'lat': ?lat,
                  'lng': ?lng,
                  'accuracyM': ?accuracyM,
                },
              )
              as Map<String, dynamic>;
      active = AttendanceSummary.fromJson(data);
      await refreshActive();
      startGeofenceMonitoring();
      return true;
    } on ApiException catch (e) {
      errorMessage = e.message;
      errorCode = e.code;
      return false;
    } catch (_) {
      errorMessage = 'Something went wrong. Please try again.';
      return false;
    } finally {
      isBusy = false;
      notifyListeners();
    }
  }

  Future<bool> clockOut({
    required String qrToken,
    double? lat,
    double? lng,
    double? accuracyM,
  }) async {
    if (isBusy) return false;
    isBusy = true;
    errorMessage = null;
    errorCode = null;
    notifyListeners();
    try {
      final result = await _api.post(
        '/attendance/clock-out',
        body: {
          'qrToken': qrToken,
          'lat': ?lat,
          'lng': ?lng,
          'accuracyM': ?accuracyM,
        },
      );
      final completed = AttendanceSummary.fromJson(
        result as Map<String, dynamic>,
      );
      history = [completed, ...history.where((row) => row.id != completed.id)];
      active = null;
      stopGeofenceMonitoring();
      await loadHistory();
      return true;
    } on ApiException catch (e) {
      errorMessage = e.message;
      errorCode = e.code;
      return false;
    } catch (_) {
      errorMessage = 'Something went wrong. Please try again.';
      return false;
    } finally {
      isBusy = false;
      notifyListeners();
    }
  }

  /// Starts watching device position (fires on ~50m movement, never a
  /// fixed-interval poll) while a shift is live — stopped the moment the
  /// staff member clocks out, either manually or automatically below. Safe
  /// to call repeatedly (e.g. after `refreshActive()` restores an already-
  /// open attendance on app resume): a stream already running is left as-is.
  void startGeofenceMonitoring() {
    if (_geofenceSub != null || active == null) return;
    try {
      _geofenceSub = Geolocator.getPositionStream(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          distanceFilter: 50,
        ),
      ).listen(_onPositionUpdate, onError: (_) {});
    } catch (_) {
      // No platform location stream available (e.g. no location plugin
      // registered in this environment) — auto clock-out on geofence exit
      // is simply unavailable; the staff member can still always Clock Out
      // manually via QR, so this never blocks the live shift.
    }
  }

  void stopGeofenceMonitoring() {
    _geofenceSub?.cancel();
    _geofenceSub = null;
  }

  Future<void> _onPositionUpdate(Position position) async {
    if (active == null) return;
    try {
      final data =
          await _api.post(
                '/attendance/geofence-exit',
                body: {
                  'lat': position.latitude,
                  'lng': position.longitude,
                  if (position.accuracy > 0) 'accuracyM': position.accuracy,
                },
              )
              as Map<String, dynamic>;
      // The server re-verifies the exit independently (never trusts this
      // report alone) — a 409 "still inside" no-op throws and is swallowed
      // below; only a genuine auto clock-out updates state here.
      active = AttendanceSummary.fromJson(data);
      stopGeofenceMonitoring();
      await loadHistory();
      notifyListeners();
    } catch (_) {
      // Still inside the geofence, or a transient network error — no state
      // change, keep monitoring.
    }
  }

  @override
  void dispose() {
    stopGeofenceMonitoring();
    super.dispose();
  }
}
