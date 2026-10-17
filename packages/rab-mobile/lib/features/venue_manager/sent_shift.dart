import 'package:flutter/painting.dart';
import 'package:intl/intl.dart';

/// Server-scoped shift projection. View labels/filters/counters are server derived.
class SentShift {
  SentShift.fromJson(this.json);
  final Map<String, dynamic> json;
  String get id => json['id'] as String;
  String get status => json['status'] as String? ?? '';
  String get role => json['roleName'] as String;
  String get venue => json['venueName'] as String;
  String get label => json['statusLabel'] as String;
  DateTime get start => DateTime.parse(json['startsAt'] as String).toLocal();
  DateTime get end => DateTime.parse(json['endsAt'] as String).toLocal();
  DateTime? get submittedAt => json['submittedAt'] == null
      ? null
      : DateTime.tryParse(json['submittedAt'] as String)?.toLocal();
  int get required => json['requiredCount'] as int;
  int count(String key) =>
      ((json['offerCounts'] as Map?)?[key] as num?)?.toInt() ?? 0;
  bool counter(String key) => (json['counters'] as Map?)?[key] == true;
  bool matches(String? status) =>
      status == null ||
      ((json['filters'] as List?) ?? const []).contains(status);
}

/// Card/pill colours and pill text for one sent shift.
class SentShiftLook {
  const SentShiftLook(this.label, this.card, this.pill, this.pillText);
  final String label;
  final Color card, pill, pillText;
}

const _peach = SentShiftLook(
  '',
  Color(0xFFFDEEE6),
  Color(0xFFFCD9CF),
  Color(0xFFE8590C),
);
const _mint = SentShiftLook(
  '',
  Color(0xFFEAFBF1),
  Color(0xFFC8F0D8),
  Color(0xFF18794E),
);
const _blue = SentShiftLook(
  '',
  Color(0xFFEAF2FD),
  Color(0xFFCFE1FB),
  Color(0xFF1D4ED8),
);
const _red = SentShiftLook(
  '',
  Color(0xFFFDECEC),
  Color(0xFFF9D2D2),
  Color(0xFFB42318),
);
const _grey = SentShiftLook(
  '',
  Color(0xFFF2F2F2),
  Color(0xFFE2E2E2),
  Color(0xFF555555),
);
const _neutral = SentShiftLook(
  '',
  Color(0xFFFAF9F6),
  Color(0xFFECEAE5),
  Color(0xFF555555),
);

SentShiftLook _as(SentShiftLook tone, String label) =>
    SentShiftLook(label, tone.card, tone.pill, tone.pillText);

/// Maps the REAL server state to the card's pill text and colours — a pure
/// read of `status`, `counters` and `offerCounts`; it never infers progress
/// from the clock and never relabels one state as another. The server's
/// `sentShiftPresentation` (rab-server scheduling/services) is the source of
/// those counters; the precedence below mirrors its `statusLabel` order:
///
/// | Real state                                         | Pill               | Tone       |
/// |----------------------------------------------------|--------------------|------------|
/// | status `pending_manager_approval`                  | Pending approval   | peach      |
/// | status `declined` (request declined)               | Declined           | light red  |
/// | status `cancelled`                                 | Cancelled          | grey       |
/// | status `completed`                                 | Completed          | grey       |
/// | `counters.confirmed` (every seat confirmed)        | Confirmed          | light blue |
/// | `counters.accepted` (some accepted, not all conf.) | Accepted           | mint       |
/// | `offerCounts.pending > 0` (offers out, no accepts) | Pending            | peach      |
/// | `offerCounts.declined > 0` (staff declined)        | Declined           | light red  |
/// | `offerCounts.cancelled > 0` (staff cancelled)      | Staff cancelled    | grey       |
/// | anything else (no offers / none active)            | No active offers   | off-white  |
///
/// "Staff cancelled" keeps the server's own wording so a staff-side
/// cancellation is never shown as the whole shift being cancelled.
SentShiftLook sentShiftLook(SentShift shift) {
  switch (shift.status) {
    case 'pending_manager_approval':
      return _as(_peach, 'Pending approval');
    case 'declined':
      return _as(_red, 'Declined');
    case 'cancelled':
      return _as(_grey, 'Cancelled');
    case 'completed':
      return _as(_grey, 'Completed');
  }
  if (shift.counter('confirmed')) return _as(_blue, 'Confirmed');
  if (shift.counter('accepted')) return _as(_mint, 'Accepted');
  if (shift.count('pending') > 0) return _as(_peach, 'Pending');
  if (shift.count('declined') > 0) return _as(_red, 'Declined');
  if (shift.count('cancelled') > 0) return _as(_grey, 'Staff cancelled');
  return _as(_neutral, 'No active offers');
}

/// Reports ("Event staffing summaries") card tone + pill text: a direct,
/// display-only read of the shift's real `status` (ShiftStatus in
/// @rab/shared), sharing the Sent Shifts tones. Nothing is inferred from
/// the clock; an unknown status shows its own words on the neutral tone.
SentShiftLook reportEventLook(String status) => switch (status) {
  'fully_filled' => _as(_mint, 'Fully filled'),
  'confirmed' => _as(_blue, 'Confirmed'),
  'in_progress' => _as(_peach, 'In progress'),
  'partially_filled' => _as(_peach, 'Partially filled'),
  'offered' => _as(_blue, 'Offered'),
  'open' => _as(_neutral, 'Open'),
  'pending_manager_approval' => _as(_peach, 'Pending approval'),
  'declined' => _as(_red, 'Declined'),
  'completed' => _as(_grey, 'Completed'),
  'cancelled' => _as(_grey, 'Cancelled'),
  'draft' => _as(_neutral, 'Draft'),
  _ => _as(_neutral, status.replaceAll('_', ' ')),
};

/// "Sent just now" / "Sent 5m ago" / "Sent 2h ago" / "Sent 3d ago", then an
/// absolute date after a week. A timestamp ahead of the device clock (skew)
/// reads as "just now" rather than a negative age.
String sentAgo(DateTime submittedAt, DateTime now) {
  final age = now.difference(submittedAt);
  if (age.inMinutes < 1) return 'Sent just now';
  if (age.inHours < 1) return 'Sent ${age.inMinutes}m ago';
  if (age.inDays < 1) return 'Sent ${age.inHours}h ago';
  if (age.inDays < 7) return 'Sent ${age.inDays}d ago';
  return 'Sent ${DateFormat('d MMM yyyy').format(submittedAt)}';
}

/// "Sat 26 Apr 2025".
String sentShiftDate(DateTime start) =>
    DateFormat('EEE d MMM yyyy').format(start);

/// "18:00 - 02:00 (+1)" — the suffix appears only when the end falls on a
/// later calendar day than the start (both already local).
String sentShiftTimeRange(DateTime start, DateTime end) {
  final overnight = !_sameDay(start, end);
  return '${DateFormat('HH:mm').format(start)} - '
      '${DateFormat('HH:mm').format(end)}${overnight ? ' (+1)' : ''}';
}

bool _sameDay(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;
