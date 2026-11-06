import 'offer_confirmation.dart';

export 'offer_confirmation.dart';

/// Mirrors `OfferSummary` in `packages/rab-server/src/modules/offer/services/offer.service.ts`.
abstract interface class ShiftDeckRecord {
  String get id;
  String get shiftId;
}

class OfferSummary implements ShiftDeckRecord {
  @override
  final String id;
  final String status;
  final DateTime sentAt;
  final DateTime expiresAt;
  final DateTime? respondedAt;
  final String? declineReason;
  final DateTime? staffAcceptedAt;
  final DateTime? managerConfirmedAt;
  final DateTime? managerRejectedAt;
  final String? rejectionReason;
  final int estimatedPayPence;
  @override
  final String shiftId;
  final DateTime startsAt;
  final DateTime endsAt;
  final String venueName;
  final String roleName;
  final String staffProfileId;
  final String staffName;
  final int payRatePence;
  final String? venueAddress;
  final String? shiftNotes;

  /// Venue profile photo (`GET /files/:id`); null when the venue has none or
  /// the server predates the field.
  final String? venuePhotoFileId;
  final StaffShiftPresentation? presentation;

  /// This booking needs a Check In before Clock In. False for bookings made
  /// before Check In shipped (old flow) and from servers without the field.
  final bool checkInRequired;

  /// Server time of the booking's Check In, or null.
  final DateTime? checkedInAt;

  /// `staff` | `qr` | null.
  final String? checkInSource;

  /// The venue requires location for Check In / Clock In / Clock Out. Null
  /// when the server did not say (older server): the app then keeps its
  /// previous behaviour and asks for location.
  final bool? geofenceEnforced;

  /// Server-computed approval deadline (STANDARD: assignment start − 30 min;
  /// REPLACEMENT / STANDBY: the end of the booked window). Display only; null
  /// from a server that predates the field (then nothing is shown).
  final DateTime? approvalDeadlineAt;

  /// `status = staff_accepted AND database now < approvalDeadlineAt`. Null
  /// from an older server: the app then keeps its previous behaviour.
  final bool? awaitingManagerConfirmation;

  /// [OfferClosedReason] value or null.
  final String? closedReason;

  /// Manager reads only (`GET /offers`); never sent on `/offers/mine`.
  final bool? canConfirm;

  /// `/offers/mine`: false when the server refuses an accept now (e.g. a
  /// STANDARD offer past its approval deadline). Null from an older server:
  /// Accept stays and the server's 409 message is shown instead.
  final bool? canAccept;

  OfferSummary({
    required this.id,
    required this.status,
    required this.sentAt,
    required this.expiresAt,
    this.respondedAt,
    this.declineReason,
    this.staffAcceptedAt,
    this.managerConfirmedAt,
    this.managerRejectedAt,
    this.rejectionReason,
    required this.estimatedPayPence,
    required this.shiftId,
    required this.startsAt,
    required this.endsAt,
    required this.venueName,
    required this.roleName,
    required this.staffProfileId,
    required this.staffName,
    required this.payRatePence,
    this.venueAddress,
    this.shiftNotes,
    this.venuePhotoFileId,
    this.presentation,
    this.checkInRequired = false,
    this.checkedInAt,
    this.checkInSource,
    this.geofenceEnforced,
    this.approvalDeadlineAt,
    this.awaitingManagerConfirmation,
    this.closedReason,
    this.canConfirm,
    this.canAccept,
  });

  /// Server says this pending offer can no longer be accepted.
  /// Display only: POST accept stays the authority. Missing = unknown, so the
  /// button stays.
  bool get acceptRefused =>
      status == 'pending' && (canAccept ?? presentation?.canAccept) == false;

  /// Why the offer is closed: the row's own `closedReason`, else the staff
  /// presentation's. Null when open, unknown or from an older server.
  String? get effectiveClosedReason =>
      closedReason ?? presentation?.closedReason;

  /// Withdrawn at its approval deadline without a manager confirmation (also
  /// when the server projects it so before the Worker has run).
  bool get withdrawnAtDeadline =>
      effectiveClosedReason == OfferClosedReason.confirmationDeadlinePassed;

  /// Accepted by the staff member and still waiting for a manager to confirm.
  /// A missing `awaitingManagerConfirmation` (older server) keeps the previous
  /// reading of `staff_accepted`; a server `false`, a closed reason or a
  /// `rejected` presentation never reads as awaiting.
  bool get isAwaitingManagerConfirmation =>
      status == 'staff_accepted' &&
      awaitingManagerConfirmation != false &&
      effectiveClosedReason == null &&
      presentation?.state != 'rejected';

  factory OfferSummary.fromJson(Map<String, dynamic> json) {
    DateTime? parseNullable(dynamic v) =>
        v == null ? null : DateTime.parse(v as String);
    return OfferSummary(
      id: json['id'] as String,
      status: json['status'] as String,
      sentAt: DateTime.parse(json['sentAt'] as String),
      expiresAt: DateTime.parse(json['expiresAt'] as String),
      respondedAt: parseNullable(json['respondedAt']),
      declineReason: json['declineReason'] as String?,
      staffAcceptedAt: parseNullable(json['staffAcceptedAt']),
      managerConfirmedAt: parseNullable(json['managerConfirmedAt']),
      managerRejectedAt: parseNullable(json['managerRejectedAt']),
      rejectionReason: json['rejectionReason'] as String?,
      estimatedPayPence: json['estimatedPayPence'] as int,
      shiftId: json['shiftId'] as String,
      startsAt: DateTime.parse(json['startsAt'] as String),
      endsAt: DateTime.parse(json['endsAt'] as String),
      venueName: json['venueName'] as String,
      roleName: json['roleName'] as String,
      staffProfileId: json['staffProfileId'] as String,
      staffName: json['staffName'] as String,
      payRatePence: json['payRatePence'] as int,
      venueAddress: json['venueAddress'] as String?,
      shiftNotes: json['shiftNotes'] as String?,
      venuePhotoFileId: json['venuePhotoFileId'] as String?,
      presentation: json['presentation'] is Map<String, dynamic>
          ? StaffShiftPresentation.fromJson(
              json['presentation'] as Map<String, dynamic>,
            )
          : null,
      checkInRequired: json['checkInRequired'] as bool? ?? false,
      checkedInAt: parseNullable(json['checkedInAt']),
      checkInSource: json['checkInSource'] as String?,
      geofenceEnforced: json['geofenceEnforced'] as bool?,
      approvalDeadlineAt: _parseDate(json['approvalDeadlineAt']),
      awaitingManagerConfirmation: json['awaitingManagerConfirmation'] is bool
          ? json['awaitingManagerConfirmation'] as bool
          : null,
      closedReason: json['closedReason'] is String
          ? json['closedReason'] as String
          : null,
      canConfirm: json['canConfirm'] is bool
          ? json['canConfirm'] as bool
          : null,
      canAccept: json['canAccept'] is bool ? json['canAccept'] as bool : null,
    );
  }
}

/// Tolerant ISO parse for fields a server may not send yet.
DateTime? _parseDate(dynamic v) => v is String ? DateTime.tryParse(v) : null;

/// Read-only server projection; Flutter does not run the +2h/+6h rules.
class StaffShiftPresentation {
  StaffShiftPresentation.fromJson(Map<String, dynamic> json)
    : state = json['state'] as String,
      homeLabel = json['homeLabel'] as String,
      isToday = json['isToday'] as bool,
      serverNow = DateTime.parse(json['serverNow'] as String),
      clockInAt = json['clockInAt'] == null
          ? null
          : DateTime.parse(json['clockInAt'] as String),
      nextTransitionAt = json['nextTransitionAt'] == null
          ? null
          : DateTime.parse(json['nextTransitionAt'] as String),
      closedReason = json['closedReason'] is String
          ? json['closedReason'] as String
          : null,
      canAccept = json['canAccept'] is bool ? json['canAccept'] as bool : null;
  final String state, homeLabel;

  /// [OfferClosedReason] value or null (absent on older servers).
  final String? closedReason;

  /// Mirrors the row's `canAccept` (`/offers/mine` only); null when absent.
  final bool? canAccept;
  final bool isToday;
  final DateTime serverNow;
  final DateTime? clockInAt, nextTransitionAt;
  String get label => switch (state) {
    'pending' => 'Pending',
    'confirmed' => 'Confirmed',
    'live' => 'Live',
    'clockedOut' => 'Clocked Out',
    'complete' => 'Complete',
    'expired' => 'Expired',
    'cancelled' => 'Cancelled',
    'declined' => 'Declined',
    'ended' => 'Ended',
    'rejected' =>
      closedReason == OfferClosedReason.confirmationDeadlinePassed
          ? ConfirmationDeadlineCopy.staffState
          : 'Not confirmed',
    _ => 'Updating',
  };
}
