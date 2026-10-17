import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/features/venue_manager/report_event_card.dart';
import 'package:rab_staff/features/venue_manager/sent_shift.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';

VenueEvent event(String status, {DateTime? start, DateTime? end}) => VenueEvent(
  {
    'id': 'shift-$status',
    'status': status,
    'startsAt': (start ?? DateTime(2026, 10, 16, 15, 45))
        .toUtc()
        .toIso8601String(),
    'endsAt': (end ?? DateTime(2026, 10, 16, 22, 45)).toUtc().toIso8601String(),
    'requiredCount': 5,
    'filledCount': 3,
  },
  role: 'Test Role 1',
  venue: 'Venue Test 1',
);

void main() {
  testWidgets('shows the status pill, role, venue, date, time and the '
      'confirmed/open footer, and the card opens the report', (tester) async {
    var opened = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ReportEventCard(
            event: event('in_progress'),
            onTap: () => opened++,
          ),
        ),
      ),
    );
    for (final text in [
      'In progress',
      'Test Role 1',
      'Venue Test 1',
      'Fri 16 Oct',
      '15:45–22:45',
      '3 / 5 confirmed · 2 open',
    ]) {
      expect(find.text(text), findsOneWidget, reason: text);
    }
    expect(find.textContaining('Status:'), findsNothing);
    await tester.tap(find.text('Test Role 1'));
    expect(opened, 1);
  });

  test('pill text and tone come straight from the real shift status', () {
    expect(reportEventLook('fully_filled').label, 'Fully filled');
    expect(reportEventLook('in_progress').label, 'In progress');
    expect(
      reportEventLook('fully_filled').card,
      isNot(reportEventLook('in_progress').card),
    );
    expect(reportEventLook('something_new').label, 'something new');
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
