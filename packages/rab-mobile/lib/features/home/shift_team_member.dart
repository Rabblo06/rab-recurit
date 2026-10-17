/// Minimal staff-facing projection. No profile identifiers, contact or pay data.
class ShiftTeamMember {
  const ShiftTeamMember({
    required this.displayName,
    required this.startsAt,
    required this.endsAt,
    required this.isYou,
  });
  final String displayName;
  final DateTime startsAt, endsAt;
  final bool isYou;
  factory ShiftTeamMember.fromJson(Map<String, dynamic> json) =>
      ShiftTeamMember(
        displayName: json['displayName'] as String,
        startsAt: DateTime.parse(json['startsAt'] as String),
        endsAt: DateTime.parse(json['endsAt'] as String),
        isYou: json['isYou'] as bool,
      );
}
