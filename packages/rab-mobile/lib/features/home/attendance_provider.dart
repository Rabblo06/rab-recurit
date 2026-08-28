import 'package:flutter/foundation.dart';

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

  Future<void> refreshActive() async {
    isLoadingActive = true;
    notifyListeners();
    try {
      final data = await _api.get('/attendance/me/active') as Map<String, dynamic>;
      final attendanceJson = data['attendance'] as Map<String, dynamic>?;
      active = attendanceJson == null ? null : AttendanceSummary.fromJson(attendanceJson);
    } catch (_) {
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
      history = data.map((e) => AttendanceSummary.fromJson(e as Map<String, dynamic>)).toList();
    } catch (_) {
      // Leave the previous list in place on a transient failure.
    } finally {
      isLoadingHistory = false;
      notifyListeners();
    }
  }

  /// Only ever reflects success after the backend confirms — no optimistic
  /// "clocked in" state before the response lands, so a network failure
  /// never shows a clock-in that didn't actually happen.
  Future<bool> clockIn(String shiftId) async {
    isBusy = true;
    errorMessage = null;
    notifyListeners();
    try {
      final data = await _api.post('/attendance/clock-in', body: {'shiftId': shiftId}) as Map<String, dynamic>;
      active = AttendanceSummary.fromJson(data);
      return true;
    } on ApiException catch (e) {
      errorMessage = e.message;
      return false;
    } catch (_) {
      errorMessage = 'Something went wrong. Please try again.';
      return false;
    } finally {
      isBusy = false;
      notifyListeners();
    }
  }

  Future<bool> clockOut() async {
    isBusy = true;
    errorMessage = null;
    notifyListeners();
    try {
      await _api.post('/attendance/clock-out');
      active = null;
      await loadHistory();
      return true;
    } on ApiException catch (e) {
      errorMessage = e.message;
      return false;
    } catch (_) {
      errorMessage = 'Something went wrong. Please try again.';
      return false;
    } finally {
      isBusy = false;
      notifyListeners();
    }
  }
}
