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
  });

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
    );
  }
}

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
          : DateTime.parse(json['nextTransitionAt'] as String);
  final String state, homeLabel;
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
    'rejected' => 'Not confirmed',
    _ => 'Updating',
  };
}
