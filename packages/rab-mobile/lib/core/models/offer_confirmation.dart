/// Dart mirror of `@rab/shared` `constants/offer-confirmation.ts` (the frozen
/// manager-confirmation deadline contract, owner rule 2026-11-06). Literals
/// only: the app never computes a deadline and never decides anything with
/// the device clock. It DISPLAYS the server's `approvalDeadlineAt`.
///
/// The rule: the system never confirms an offer; only the sending Internal
/// Manager does, before the approval deadline (STANDARD: assignment start
/// − 30 min; REPLACEMENT / STANDBY: the end of the booked window). An
/// acceptance still unconfirmed at the deadline is withdrawn.
library;

import 'package:intl/intl.dart';

/// `OFFER_CLOSED_REASON` (projected as `closedReason`).
abstract final class OfferClosedReason {
  static const confirmationDeadlinePassed = 'confirmation_deadline_passed';
  static const shiftCancelled = 'shift_cancelled';
}

/// `body.code` of every 409 this rule produces (`CONFIRMATION_DEADLINE_PASSED`).
const confirmationDeadlinePassedCode = 'CONFIRMATION_DEADLINE_PASSED';

/// `CONFIRMATION_DEADLINE_LABELS` and the notification wording.
abstract final class ConfirmationDeadlineCopy {
  /// Staff chip / state label for a deadline withdrawal (owner decision Q7).
  static const staffState = 'Withdrawn';

  /// Staff detail line: the owner's exact notification body.
  static const staffDetail =
      'Your shift offer was withdrawn because final manager confirmation was not received before the approval deadline.';

  /// Manager / Venue Manager label for a withdrawn row.
  static const managerState = 'Not confirmed in time';

  /// Staff badge for an acceptance a manager has not confirmed yet.
  static const awaiting = 'Awaiting manager confirmation';

  /// Notification types the rule writes (existing types).
  static const staffNotificationType = 'offer_rejected';
  static const managerNotificationType = 'manager_confirmation_timeout';
}

/// Label of the disabled Accept when the server sends `canAccept: false`.
const tooLateToAcceptLabel = 'Too late to accept';

/// The server's deadline as local wall time: "HH:mm" when it falls on the
/// shift's own start day, otherwise "EEE d MMM, HH:mm". Formatting only; the
/// instant itself always comes from `approvalDeadlineAt`.
String approvalDeadlineTime(DateTime deadline, DateTime startsAt) {
  final d = deadline.toLocal();
  final s = startsAt.toLocal();
  final sameDay = d.year == s.year && d.month == s.month && d.day == s.day;
  return DateFormat(sameDay ? 'HH:mm' : 'EEE d MMM, HH:mm').format(d);
}
