import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

import '../../core/api/api_client.dart';
import '../../core/api/attendance_messages.dart';
import '../../core/models/attendance.dart';
import '../../core/models/offer.dart';
import '../../core/polling/keyset_pages.dart';
import '../../core/services/location_service.dart';
import 'shift_team_member.dart';

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

  /// [background]: the Teams screen's timer refresh (`X-Crewflow-Background`).
  Future<List<ShiftTeamMember>> loadTeam(
    String shiftId, {
    bool background = false,
  }) async {
    final rows =
        await _api.get(
              '/attendance/me/shift/${Uri.encodeComponent(shiftId)}/team',
              background: background,
            )
            as List<dynamic>;
    return rows
        .map((row) => ShiftTeamMember.fromJson(row as Map<String, dynamic>))
        .toList();
  }

  AttendanceSummary? active;
  List<AttendanceSummary> history = [];
  static const historyPageSize = 200;
  int _activeSequence = 0;
  bool _disposed = false;

  /// The error of the last `/attendance/me/active` read (null after a
  /// success), for pollers' backoff.
  Object? lastActiveFailure;
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
  int? clockInEarlyMinutes;
  final Stopwatch _sinceServerTime = Stopwatch();
  DateTime? get trustedNow => serverNow?.add(_sinceServerTime.elapsed);

  /// `locationEvidence` from `GET /attendance/me/active`: what a location fix
  /// must satisfy at a geofence-enforcing venue. Pre-check only.
  LocationEvidenceLimits? locationEvidence;

  /// The server's Check In state per shift (from GET/POST check-in). Wins
  /// over the offer's own fields, which can be a poll behind.
  final Map<String, CheckInState> checkIns = {};

  /// Server time of [offer]'s Check In, or null.
  DateTime? checkedInAt(OfferSummary offer) =>
      checkIns[offer.shiftId]?.checkedInAt ?? offer.checkedInAt;

  bool checkInRequired(OfferSummary offer) =>
      checkIns[offer.shiftId]?.checkInRequired ?? offer.checkInRequired;

  /// The booking needs a Check In before Clock In and has none yet. Bookings
  /// made before Check In shipped (`checkInRequired: false`) keep the old flow.
  bool needsCheckIn(OfferSummary offer) =>
      checkInRequired(offer) && checkedInAt(offer) == null;

  /// Whether the shift's venue requires location: the check-in state first,
  /// then the offer. Null = unknown (older server) → the caller keeps the
  /// previous behaviour and asks for location.
  bool? geofenceEnforced(String shiftId, {OfferSummary? offer}) =>
      checkIns[shiftId]?.geofenceEnforced ?? offer?.geofenceEnforced;

  void _anchor(String? serverNowRaw) {
    final parsed = serverNowRaw == null
        ? null
        : DateTime.tryParse(serverNowRaw);
    if (parsed == null) return;
    serverNow = parsed;
    _sinceServerTime
      ..reset()
      ..start();
  }

  /// A fix the server would certainly refuse is explained without a request.
  bool _rejectFix(LocationFix? fix) {
    final limits = locationEvidence;
    if (fix == null || limits == null) return false;
    final now = trustedNow;
    String? code;
    if (fix.accuracyM > limits.maxAccuracyM) {
      code = 'LOCATION_ACCURACY_TOO_LOW';
    } else if (now != null &&
        now.difference(fix.capturedAt).inSeconds > limits.maxAgeSeconds) {
      code = 'LOCATION_STALE';
    }
    if (code == null) return false;
    errorCode = code;
    errorMessage = AttendanceMessages.staff[code];
    notifyListeners();
    return true;
  }

  void _fail(Object error) {
    errorMessage = AttendanceMessages.forStaff(error);
    errorCode = error is ApiException ? error.code : null;
  }

  /// `GET /attendance/me/shift/:shiftId/check-in`. Silent: a failure keeps
  /// whatever was known (the offer's own fields still apply).
  Future<CheckInState?> loadCheckIn(String shiftId) async {
    try {
      final data =
          await _api.get(
                '/attendance/me/shift/${Uri.encodeComponent(shiftId)}/check-in',
              )
              as Map<String, dynamic>;
      final state = CheckInState.fromJson(data);
      checkIns[shiftId] = state;
      notifyListeners();
      return state;
    } catch (_) {
      return null;
    }
  }

  /// Staff Check In — arrival evidence, never worked time. Success is shown
  /// only after the server answers; a repeat returns the original check-in
  /// (`alreadyCheckedIn`). [location] is sent only when the venue enforces
  /// its geofence (the caller never asks for location otherwise).
  Future<bool> checkIn(
    String shiftId, {
    LocationFix? location,
    String? qrToken,
  }) async {
    if (isBusy) return false;
    errorMessage = null;
    errorCode = null;
    if (_rejectFix(location)) return false;
    isBusy = true;
    notifyListeners();
    try {
      final data =
          await _api.post(
                '/attendance/check-in',
                body: {
                  'shiftId': shiftId,
                  ...?location?.toJson(),
                  'qrToken': ?qrToken,
                },
              )
              as Map<String, dynamic>;
      checkIns[shiftId] = CheckInState.fromJson(data);
      _anchor(data['serverNow'] as String?);
      return true;
    } catch (e) {
      _fail(e);
      return false;
    } finally {
      isBusy = false;
      notifyListeners();
    }
  }

  StreamSubscription<Position>? _geofenceSub;

  /// `silent: true` is for a refresh the user never asked for and has no
  /// reason to see — the 30s background reconcile and the app-resume
  /// refresh (`app_shell.dart`, `schedule_clock_screen.dart`) both already
  /// have good data on screen; flipping `isLoadingActive` back to `true` for
  /// those made Home/Clock flash back to their loading skeleton every ~30s
  /// and on every unlock, exactly mirroring `OffersProvider.load`'s own
  /// `silent` parameter and the same bug class fixed on the web Users table
  /// (`isFetching` driving a visible loading state for an invisible
  /// background poll). A real first load, pull-to-refresh's own spinner
  /// already being visible, or an explicit "Retry" tap should still show it.
  ///
  /// [background]: AppShell's timer reconcile (`X-Crewflow-Background`). Only
  /// the most recently started read is applied, so a slow poll can never
  /// overwrite the state a clock-in/out just reloaded.
  Future<void> refreshActive({
    bool silent = false,
    bool background = false,
  }) async {
    final sequence = ++_activeSequence;
    if (!silent) {
      isLoadingActive = true;
      notifyListeners();
    }
    try {
      final data =
          await _api.get('/attendance/me/active', background: background)
              as Map<String, dynamic>;
      if (_disposed || sequence != _activeSequence) return;
      final attendanceJson = data['attendance'] as Map<String, dynamic>?;
      active = attendanceJson == null
          ? null
          : AttendanceSummary.fromJson(attendanceJson);
      final serverNowRaw = data['serverNow'] as String?;
      final early = data['clockInEarlyMinutes'];
      clockInEarlyMinutes = early is int && early >= 0 ? early : null;
      locationEvidence =
          LocationEvidenceLimits.maybe(data['locationEvidence']) ??
          locationEvidence;
      _anchor(serverNowRaw);
      activeLoadError = null;
      lastActiveFailure = null;
      // Restores geofence monitoring across an app kill/reopen while a
      // shift is still live — mirrors how the timer itself survives restart
      // by re-deriving from the server rather than local state.
      if (active != null) {
        startGeofenceMonitoring();
      } else {
        stopGeofenceMonitoring();
      }
    } catch (e) {
      if (_disposed || sequence != _activeSequence) return;
      activeLoadError = 'Could not check attendance. Please try again.';
      lastActiveFailure = e;
      // A failed restore leaves `active` as-is rather than clearing a
      // possibly-still-valid state on a transient network error.
    } finally {
      if (!_disposed && sequence == _activeSequence) {
        isLoadingActive = false;
        notifyListeners();
      }
    }
  }

  /// `silent: true` — see `refreshActive`'s own doc comment; same reasoning,
  /// since `isLoadingHistory` feeds the same loading-state checks.
  ///
  /// [background]: a realtime-driven reload (`X-Crewflow-Background`).
  Future<void> loadHistory({
    bool silent = false,
    bool background = false,
  }) async {
    if (!silent) {
      isLoadingHistory = true;
      notifyListeners();
    }
    try {
      // Every page (keyset, API contract §3), never truncated.
      final data = await fetchAllKeysetPages(
        _api,
        '/attendance/me/history',
        limit: historyPageSize,
        background: background,
      );
      history = data.map(AttendanceSummary.fromJson).toList();
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
  /// required (the backend rejects a clock-in without one); [location] is
  /// sent when the venue enforces its geofence (or, for an older server that
  /// does not say, as before). A `CHECK_IN_REQUIRED` refusal reloads the
  /// booking's Check In state so the screen offers Check In.
  Future<bool> clockIn(
    String shiftId, {
    required String qrToken,
    LocationFix? location,
  }) async {
    if (isBusy) return false;
    errorMessage = null;
    errorCode = null;
    if (_rejectFix(location)) return false;
    isBusy = true;
    notifyListeners();
    try {
      final data =
          await _api.post(
                '/attendance/clock-in',
                body: {
                  'shiftId': shiftId,
                  'qrToken': qrToken,
                  ...?location?.toJson(),
                },
              )
              as Map<String, dynamic>;
      active = AttendanceSummary.fromJson(data);
      await refreshActive();
      startGeofenceMonitoring();
      return true;
    } catch (e) {
      _fail(e);
      if (errorCode == 'CHECK_IN_REQUIRED') unawaited(loadCheckIn(shiftId));
      return false;
    } finally {
      isBusy = false;
      notifyListeners();
    }
  }

  Future<bool> clockOut({
    required String qrToken,
    LocationFix? location,
  }) async {
    if (isBusy) return false;
    errorMessage = null;
    errorCode = null;
    if (_rejectFix(location)) return false;
    isBusy = true;
    notifyListeners();
    try {
      final result = await _api.post(
        '/attendance/clock-out',
        body: {'qrToken': qrToken, ...?location?.toJson()},
      );
      final completed = AttendanceSummary.fromJson(
        result as Map<String, dynamic>,
      );
      history = [completed, ...history.where((row) => row.id != completed.id)];
      active = null;
      stopGeofenceMonitoring();
      await loadHistory();
      return true;
    } catch (e) {
      _fail(e);
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
  /// Never for a venue known not to enforce its geofence: no location is
  /// read or sent there.
  void startGeofenceMonitoring() {
    if (_geofenceSub != null || active == null) return;
    if (geofenceEnforced(active!.shiftId) == false) return;
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
                body: LocationFix.fromPosition(
                  position,
                  trustedNow: trustedNow,
                ).toJson(),
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
    _disposed = true;
    stopGeofenceMonitoring();
    super.dispose();
  }
}
