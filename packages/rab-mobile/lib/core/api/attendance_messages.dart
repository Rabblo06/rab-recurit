import 'api_client.dart';

/// Friendly text for the structured attendance error `code`s the server
/// returns (`attendance.exceptions.ts`). Shared by the staff Check In / Clock
/// In / Clock Out flow and the Venue Manager on-behalf punches, so one code
/// always reads the same. Unknown codes and non-API failures go through the
/// app's one normaliser ([userMessageFor]).
abstract final class AttendanceMessages {
  static const staff = <String, String>{
    'CHECK_IN_REQUIRED': 'Check in at the venue before you clock in.',
    'CHECK_IN_TOO_EARLY': 'It is too early to check in for this shift.',
    'CHECK_IN_WINDOW_CLOSED': "This shift's check-in window has closed.",
    'CLOCK_IN_TOO_EARLY': 'It is too early to clock in for this shift.',
    'CLOCK_WINDOW_CLOSED': "This shift's clock-in/out window has closed.",
    'LOCATION_REQUIRED':
        'This venue needs your location. Turn on location and try again.',
    'LOCATION_STALE':
        'Your location reading is out of date. Refresh your location and try again.',
    'LOCATION_ACCURACY_TOO_LOW':
        "We couldn't confirm your location accurately enough. Move to an open area and try again.",
    'OUTSIDE_GEOFENCE': "You're outside the venue's permitted check-in area.",
    'GEOFENCE_MISCONFIGURED':
        "This venue's location check isn't set up correctly. Ask your manager to update the venue's location settings.",
    'ATTENDANCE_FLAGGED_MISSING':
        'Your attendance for this shift was flagged as missing. Ask the venue manager to record your attendance.',
    'SHIFT_NOT_CONFIRMED': 'This shift is not confirmed for you.',
    'SHIFT_NOT_OPEN': 'This shift is not open for attendance.',
    'ALREADY_CLOCKED_IN': 'You have already clocked in for this shift.',
    'NOT_CLOCKED_IN': 'You are not clocked in for this shift.',
  };

  /// Venue Manager wording. The server's own message is preferred when it is
  /// user-facing (it names the staff member); these are the fallbacks.
  static const manager = <String, String>{
    'STAFF_NOT_CHECKED_IN':
        "Staff hasn't checked in yet. They must check in before you can clock them in.",
    'PRESENCE_NOT_VERIFIED':
        "This venue requires location, and the staff member's check-in was not location-verified. Ask them to clock in on their phone, or record their attendance in the shift report.",
    'PRESENCE_EVIDENCE_REQUIRED':
        'This venue requires location for clock-out, which a manager cannot provide. Ask the staff member to clock out on their phone, or record the clock-out in Review staff report → Record attendance once the shift has ended.',
    'REASON_TOO_SHORT': 'Add a reason of at least 10 words.',
    'ALREADY_CLOCKED_IN': 'This staff member has already clocked in.',
    'NOT_CLOCKED_IN': 'This staff member is not clocked in.',
    'ATTENDANCE_FLAGGED_MISSING':
        "This staff member's attendance was flagged as missing. Record their attendance in the shift report instead.",
    'SHIFT_NOT_CONFIRMED': 'This staff member is not confirmed for this shift.',
    'SHIFT_NOT_OPEN': 'This shift is not open for attendance.',
    'CLOCK_IN_TOO_EARLY': 'It is too early to clock in for this shift.',
    'CLOCK_WINDOW_CLOSED': "This shift's clock-in/out window has closed.",
    'GEOFENCE_MISCONFIGURED':
        "This venue's location check isn't set up correctly. Update the venue's location settings.",
  };

  /// Staff text: the code's own wording first (some server texts carry raw
  /// timestamps), then the normaliser.
  static String forStaff(Object error) {
    if (error is ApiException) {
      final mapped = staff[error.code];
      if (mapped != null) return mapped;
    }
    return userMessageFor(error);
  }

  /// Manager text: the server's user-facing text first, else the code's
  /// wording, else the normaliser.
  static String forManager(Object error) {
    if (error is ApiException) {
      final mapped = manager[error.code];
      if (mapped != null && error.statusCode < 500) {
        return isUserFacingMessage(error.message)
            ? error.message.trim()
            : mapped;
      }
    }
    return userMessageFor(error);
  }
}
