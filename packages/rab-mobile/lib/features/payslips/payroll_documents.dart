/// Mirrors `GET /payroll/me/statements` (server `payroll.controller.ts`). Only
/// the caller's own payroll-approved shifts; figures are the approved values.
class ApprovedShiftStatement {
  ApprovedShiftStatement({
    required this.payrollRecordId,
    required this.status,
    required this.shiftId,
    required this.venueName,
    required this.roleName,
    required this.startsAt,
    required this.endsAt,
    required this.workedMinutes,
    required this.amountPence,
    required this.approvedAt,
    required this.statementState,
    this.payRatePence,
    this.payrollPeriod,
    this.payday,
    this.fileId,
    this.filename,
  });

  final String payrollRecordId, shiftId, venueName, roleName;

  /// Payroll state: approved | processing | paid. Only `paid` is a payment.
  final String status;
  final DateTime startsAt, endsAt, approvedAt;
  final int? workedMinutes, amountPence, payRatePence;

  /// Official period label / scheduled payday from the agency calendar, or
  /// null while it is not allocated ("To be confirmed").
  final String? payrollPeriod;
  final DateTime? payday;

  /// Document state: processing | available | failed.
  final String statementState;
  final String? fileId, filename;

  bool get available => statementState == 'available' && fileId != null;

  factory ApprovedShiftStatement.fromJson(Map<String, dynamic> json) {
    final statement = json['statement'] as Map<String, dynamic>?;
    DateTime? date(Object? v) => v is String ? DateTime.parse(v) : null;
    final period = json['payrollPeriod'];
    return ApprovedShiftStatement(
      payrollRecordId: json['payrollRecordId'] as String,
      status: json['status'] as String,
      shiftId: json['shiftId'] as String,
      venueName: json['venueName'] as String,
      roleName: json['roleName'] as String,
      startsAt: DateTime.parse(json['startsAt'] as String),
      endsAt: DateTime.parse(json['endsAt'] as String),
      workedMinutes: (json['workedMinutes'] as num?)?.toInt(),
      amountPence: (json['amountPence'] as num?)?.toInt(),
      payRatePence: (json['payRatePence'] as num?)?.toInt(),
      approvedAt: DateTime.parse(json['approvedAt'] as String),
      payrollPeriod: period is String
          ? period
          : period is Map<String, dynamic>
          ? formatPayPeriod(period)
          : null,
      payday: date(json['payday']),
      statementState: statement?['state'] as String? ?? 'processing',
      fileId: statement?['fileId'] as String?,
      filename: statement?['filename'] as String?,
    );
  }
}

/// "12 – 25 Oct 2026" from a server `{start, end}` period (dates, London).
String? formatPayPeriod(Map<String, dynamic> period) {
  final start = period['start'], end = period['end'];
  if (start is! String || end is! String) return null;
  final a = DateTime.parse(start), b = DateTime.parse(end);
  String day(DateTime d) => '${d.day}';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final left = a.year != b.year
      ? '${day(a)} ${months[a.month - 1]} ${a.year}'
      : a.month != b.month
      ? '${day(a)} ${months[a.month - 1]}'
      : day(a);
  return '$left – ${day(b)} ${months[b.month - 1]} ${b.year}';
}

/// Mirrors `GET /payroll/me/payslips`: the agency's fortnightly payslip per
/// payroll period. Figures are never calculated in the app; `netPence` is only
/// ever the provider document's figure. `paid` only after confirmed payment.
class OfficialPayslip {
  OfficialPayslip({
    required this.periodLabel,
    required this.payday,
    required this.status,
    required this.shiftCount,
    required this.grossPence,
    this.netPence,
    this.fileId,
    this.filename,
    this.paidAt,
  });

  final String periodLabel;
  final DateTime payday;

  /// upcoming | processing | available | paid
  final String status;
  final int shiftCount, grossPence;
  final int? netPence;
  final String? fileId, filename;
  final DateTime? paidAt;

  bool get hasDocument => fileId != null;

  factory OfficialPayslip.fromJson(Map<String, dynamic> json) {
    final document = json['document'] as Map<String, dynamic>?;
    return OfficialPayslip(
      periodLabel:
          formatPayPeriod(json['period'] as Map<String, dynamic>) ??
          'Pay period',
      payday: DateTime.parse(json['payday'] as String),
      status: json['status'] as String,
      shiftCount: (json['shiftCount'] as num?)?.toInt() ?? 0,
      grossPence: (json['grossPence'] as num?)?.toInt() ?? 0,
      netPence: (json['netPence'] as num?)?.toInt(),
      fileId: document?['fileId'] as String?,
      filename: document?['filename'] as String?,
      paidAt: json['paidAt'] is String
          ? DateTime.parse(json['paidAt'] as String)
          : null,
    );
  }
}
