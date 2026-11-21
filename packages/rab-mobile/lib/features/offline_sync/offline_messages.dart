import 'package:intl/intl.dart';

import 'offline_entry.dart';

/// Staff wording for the offline queue (DESIGN §3.4, §3.6, §4.6). The server's own text is never shown here: a
/// rejection is shown by its code only, and an unknown code falls back to a generic line.
abstract final class OfflineMessages {
  static const queueFull =
      'Too many actions saved on this phone. Connect to send them.';
  static const needsTicket = 'Connect once to enable offline clocking.';
  static const unreadable =
      'Saved actions on this phone could not be read. Tell your manager.';
  static const alreadySaved =
      "This is already saved on this phone. It will be sent when you're back online.";
  static const notClockedIn = 'You are not clocked in for this shift.';
  static const captureFailed =
      'This could not be saved on this phone. Connect and try again.';
  static const tooOld = 'Too old to send automatically. Tell your manager.';
  static const parked = 'Could not send. Contact support.';
  static const waiting = 'Waiting to send';
  static const notConfirmed = 'Not yet confirmed';
  static const managerCanSee =
      'Your manager can see this and can record your hours.';

  static String action(OfflinePunchType type) => switch (type) {
    OfflinePunchType.checkIn => 'Check-in',
    OfflinePunchType.clockIn => 'Clock-in',
    OfflinePunchType.breakStart => 'Break start',
    OfflinePunchType.breakEnd => 'Break end',
    OfflinePunchType.clockOut => 'Clock-out',
  };

  static String hhmm(DateTime at) => DateFormat('HH:mm').format(at.toLocal());

  /// D3 notice after the server clamped a time to the schedule (§3.6 "Applied").
  static String clamped(OfflinePunchType type, DateTime appliedAt) =>
      type == OfflinePunchType.clockOut
      ? 'Your clock-out was recorded as ${hhmm(appliedAt)}, your shift end. Ask your manager if this is wrong.'
      : 'Your clock-in was recorded as ${hhmm(appliedAt)}, your shift start. Ask your manager if this is wrong.';

  static const stillNotSent =
      'Still not sent. Connect to the internet and try again.';

  /// The amber banner (§3.6 "Queued").
  static String queuedBanner(QueuedPunch punch) =>
      "No connection. ${action(punch.entry.type)} saved on this phone at ${hhmm(punch.displayAt)}. "
      "It will be sent when you're back online.";

  /// The fixed card line (D10: a fixed time, never a ticking timer).
  static String fixedCard(QueuedPunch punch) => switch (punch.entry.type) {
    OfflinePunchType.clockIn => 'Clocked in ${hhmm(punch.displayAt)}',
    OfflinePunchType.clockOut => 'Clocked out ${hhmm(punch.displayAt)}',
    OfflinePunchType.checkIn => 'Checked in ${hhmm(punch.displayAt)}',
    OfflinePunchType.breakStart => 'Break started ${hhmm(punch.displayAt)}',
    OfflinePunchType.breakEnd => 'Break ended ${hhmm(punch.displayAt)}',
  };

  /// Plain words for a per-item rejection code (§4.6).
  static String rejection(String? code, {String? qrReason}) => switch (code) {
    'OFFLINE_NOT_ENABLED' =>
      'Offline clocking is not switched on for this venue.',
    'SYNC_TOO_LATE' => 'This was sent too long after it was saved.',
    'TIME_UNTRUSTED' =>
      'The time of this action could not be confirmed (for example, the phone restarted).',
    'ENTRY_NOT_ACCEPTED' ||
    'SIGNATURE_INVALID' ||
    'DEVICE_KEY_REVOKED' ||
    'IDEMPOTENCY_KEY_REUSED' => 'This could not be accepted from this phone.',
    'SHIFT_NOT_FOUND' => 'This shift could not be found for you.',
    'SHIFT_NOT_OPEN' => 'This shift is not open for attendance.',
    'SHIFT_NOT_CONFIRMED' => 'This shift is not confirmed for you.',
    'ATTENDANCE_FLAGGED_MISSING' =>
      'Your attendance for this shift was flagged as missing.',
    'OUTSIDE_WINDOW' => "This was outside the shift's attendance window.",
    'CHECK_IN_REQUIRED' => 'Check in at the venue before you clock in.',
    'ALREADY_ACTIVE' => 'You were already clocked in to another shift.',
    'NOT_CLOCKED_IN' => 'You were not clocked in for this shift.',
    'NO_OPEN_BREAK' => 'There was no break to end.',
    'BREAK_ALREADY_OPEN' => 'A break was already started.',
    'INVALID_QR' => switch (qrReason) {
      'expired' => 'The QR code had expired.',
      'shift_mismatch' => 'The QR code was for a different shift.',
      'venue_mismatch' => 'The QR code was for a different venue.',
      'revoked' => 'The QR code had been replaced.',
      'issued_after_punch' => 'The QR code was newer than this action.',
      _ => 'The QR code could not be accepted.',
    },
    'LOCATION_REQUIRED' => 'This venue needed your location.',
    'LOCATION_STALE' => 'Your location reading was out of date.',
    'LOCATION_ACCURACY_TOO_LOW' =>
      "Your location couldn't be confirmed accurately enough.",
    'OUTSIDE_GEOFENCE' => "You were outside the venue's permitted area.",
    'GEOFENCE_MISCONFIGURED' =>
      "This venue's location check isn't set up correctly.",
    'MOCK_LOCATION' => 'Your location came from a mock location app.',
    'MANAGER_ALREADY_RECORDED' => 'Your manager had already recorded this.',
    'REPORT_FINALISED' => "This shift's report was already finalised.",
    'DEPENDENCY_REJECTED' =>
      'An earlier action for this shift was not accepted.',
    _ => 'This action was not accepted.',
  };

  /// One line for a saved action's current state (the Saved actions list).
  static String stateLine(QueuedPunch punch) => switch (punch.state) {
    QueuedPunchState.pending => waiting,
    QueuedPunchState.rejected =>
      '${rejection(punch.code, qrReason: punch.qrReason)} $managerCanSee',
    QueuedPunchState.tooOld => tooOld,
    QueuedPunchState.parked => parked,
  };
}
