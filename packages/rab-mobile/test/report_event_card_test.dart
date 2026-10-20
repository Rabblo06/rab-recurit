import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/features/venue_manager/report_event_card.dart';
import 'package:rab_staff/features/venue_manager/sent_shift.dart';
import 'package:rab_staff/features/venue_manager/shift_report.dart';

ReportSummary summary(
  String displayStatus,
  String label, {
  bool needsAttendanceReview = false,
  bool needsAttention = false,
}) => ReportSummary.fromJson({
  'shiftId': 'shift-$displayStatus',
  'venueName': 'Venue Test 1',
  'roleName': 'Test Role 1',
  'startsAt': DateTime(2026, 10, 16, 15, 45).toUtc().toIso8601String(),
  'endsAt': DateTime(2026, 10, 16, 22, 45).toUtc().toIso8601String(),
  'shiftStatus': 'in_progress',
  'requiredCount': 5,
  'filledCount': 3,
  'staffCount': 3,
  'clockedOut': 0,
  'noShows': 0,
  'reportStatus': 'ready',
  'lifecycle': {
    'displayStatus': displayStatus,
    'displayLabel': label,
    'actionExpiresAt': DateTime(2026, 10, 17, 3, 45).toUtc().toIso8601String(),
    'actionExpired': displayStatus == 'action_expired',
    'needsAttendanceReview': needsAttendanceReview,
    'needsAttention': needsAttention,
    'deliveryState': 'not_finalised',
  },
});

Future<int Function()> pump(WidgetTester tester, ReportSummary s) async {
  var opened = 0;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ReportEventCard(report: s, onTap: () => opened++),
      ),
    ),
  );
  return () => opened;
}

void main() {
  testWidgets('shows the server lifecycle label, role, venue, date, time and '
      'the confirmed/open footer, and the card opens the report', (
    tester,
  ) async {
    final opened = await pump(
      tester,
      summary('waiting_clock_in', 'Waiting for clock-in'),
    );
    for (final text in [
      'Waiting for clock-in',
      'Test Role 1',
      'Venue Test 1',
      'Fri 16 Oct',
      '15:45–22:45',
      '3 / 5 confirmed · 2 open',
    ]) {
      expect(find.text(text), findsOneWidget, reason: text);
    }
    await tester.tap(find.text('Test Role 1'));
    expect(opened(), 1);
  });

  testWidgets('an expired shift is never shown as In progress and carries the '
      'needs-attendance-review marker', (tester) async {
    await pump(
      tester,
      summary(
        'action_expired',
        'Action expired',
        needsAttendanceReview: true,
        needsAttention: true,
      ),
    );
    expect(find.text('Action expired'), findsOneWidget);
    expect(find.text('In progress'), findsNothing);
    expect(find.text('Needs attendance review'), findsOneWidget);
  });

  test('tone follows the lifecycle; expired and cancelled are grey', () {
    final expired = reportLifecycleLook('action_expired', 'Action expired');
    final live = reportLifecycleLook('in_progress', 'In progress');
    expect(expired.label, 'Action expired');
    expect(expired.card, isNot(live.card));
    expect(reportLifecycleLook('cancelled', 'Cancelled').card, expired.card);
  });

  test('an overnight shift is marked (+1)', () {
    expect(
      ReportEventCard.timeRange(
        DateTime(2026, 10, 16, 20),
        DateTime(2026, 10, 17, 3, 15),
      ),
      '20:00–03:15 (+1)',
    );
  });
}
