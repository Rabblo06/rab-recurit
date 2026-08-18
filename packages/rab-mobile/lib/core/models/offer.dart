/// Mirrors `OfferSummary` in `packages/rab-server/src/modules/offer/services/offer.service.ts`.
class OfferSummary {
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
  final String shiftId;
  final DateTime startsAt;
  final DateTime endsAt;
  final String venueName;
  final String roleName;
  final String staffProfileId;
  final String staffName;

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
  });

  factory OfferSummary.fromJson(Map<String, dynamic> json) {
    DateTime? parseNullable(dynamic v) => v == null ? null : DateTime.parse(v as String);
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
    );
  }
}
