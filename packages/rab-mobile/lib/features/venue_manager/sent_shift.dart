/// Server-scoped shift projection. View labels/filters/counters are server derived.
class SentShift {
  SentShift.fromJson(this.json);
  final Map<String, dynamic> json;
  String get id => json['id'] as String;
  String get role => json['roleName'] as String;
  String get venue => json['venueName'] as String;
  String get label => json['statusLabel'] as String;
  DateTime get start => DateTime.parse(json['startsAt'] as String).toLocal();
  DateTime get end => DateTime.parse(json['endsAt'] as String).toLocal();
  int get required => json['requiredCount'] as int;
  int count(String key) => (json['offerCounts'] as Map)[key] as int? ?? 0;
  bool counter(String key) => (json['counters'] as Map)[key] == true;
  bool matches(String? status) =>
      status == null || (json['filters'] as List).contains(status);
}
