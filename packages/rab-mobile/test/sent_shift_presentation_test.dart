import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/features/venue_manager/sent_shift.dart';
import 'package:rab_staff/features/venue_manager/sent_shifts_screen.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';

const _zero = {
  'sent': 0,
  'pending': 0,
  'accepted': 0,
  'confirmed': 0,
  'cancelled': 0,
  'declined': 0,
  'expired': 0,
  'withdrawn': 0,
  'rejected': 0,
};

SentShift shift(
  String status, {
  Map<String, int> counts = const {},
  bool sent = false,
  bool accepted = false,
  bool confirmed = false,
  List<String> filters = const [],
  String? submittedAt,
  String startsAt = '2025-04-26T18:00:00',
  String endsAt = '2025-04-27T02:00:00',
}) => SentShift.fromJson({
  'id': 'shift-1',
  'status': status,
  'requiredCount': 5,
  'filledCount': 0,
  'startsAt': startsAt,
  'endsAt': endsAt,
  'submittedAt': submittedAt,
  'venueName': 'The Riverside Hotel',
  'roleName': 'Bartender',
  'offerCounts': {..._zero, ...counts},
  'statusLabel': 'server label',
  'filters': filters,
  'counters': {'sent': sent, 'accepted': accepted, 'confirmed': confirmed},
});

void main() {
  group('sentShiftLook maps only the real state', () {
    test('pending manager approval', () {
      final look = sentShiftLook(
        shift('pending_manager_approval', filters: ['pending']),
      );
      expect(look.label, 'Pending approval');
      expect(look.card, const Color(0xFFFDEEE6));
      expect(look.pill, const Color(0xFFFCD9CF));
      expect(look.pillText, const Color(0xFFE8590C));
    });
    test('offers out with pending responses and no acceptances', () {
      final look = sentShiftLook(
        shift('offered', counts: {'sent': 5, 'pending': 5}, sent: true),
      );
      expect(look.label, 'Pending');
      expect(look.card, const Color(0xFFFDEEE6));
    });
    test('accepted and confirmed are never conflated', () {
      final accepted = sentShiftLook(
        shift(
          'partially_filled',
          counts: {'sent': 5, 'pending': 3, 'confirmed': 2},
          sent: true,
          accepted: true,
        ),
      );
      expect(accepted.label, 'Accepted');
      expect(accepted.card, const Color(0xFFEAFBF1));
      expect(accepted.pill, const Color(0xFFC8F0D8));
      expect(accepted.pillText, const Color(0xFF18794E));
      final confirmed = sentShiftLook(
        shift(
          'fully_filled',
          counts: {'sent': 5, 'confirmed': 5},
          sent: true,
          accepted: true,
          confirmed: true,
        ),
      );
      expect(confirmed.label, 'Confirmed');
      expect(confirmed.card, const Color(0xFFEAF2FD));
      expect(confirmed.pill, const Color(0xFFCFE1FB));
      expect(confirmed.pillText, const Color(0xFF1D4ED8));
    });
    test('request declined and staff declined are Declined (light red)', () {
      for (final row in [
        shift('declined', filters: ['declined']),
        shift('offered', counts: {'sent': 2, 'declined': 2}, sent: true),
      ]) {
        final look = sentShiftLook(row);
        expect(look.label, 'Declined');
        expect(look.card, const Color(0xFFFDECEC));
        expect(look.pill, const Color(0xFFF9D2D2));
        expect(look.pillText, const Color(0xFFB42318));
      }
    });
    test('cancelled and completed are grey and terminal', () {
      // Terminal state wins even when offer counts are non-zero.
      final cancelled = sentShiftLook(
        shift('cancelled', counts: {'sent': 1, 'pending': 1, 'confirmed': 1}),
      );
      expect(cancelled.label, 'Cancelled');
      expect(cancelled.card, const Color(0xFFF2F2F2));
      expect(cancelled.pill, const Color(0xFFE2E2E2));
      expect(cancelled.pillText, const Color(0xFF555555));
      expect(sentShiftLook(shift('completed')).label, 'Completed');
      expect(sentShiftLook(shift('completed')).card, const Color(0xFFF2F2F2));
    });
    test('staff cancellation is not shown as a cancelled shift', () {
      final look = sentShiftLook(
        shift('offered', counts: {'sent': 1, 'cancelled': 1}, sent: true),
      );
      expect(look.label, 'Staff cancelled');
    });
    test('no offers / none active is a neutral card', () {
      for (final row in [
        shift('open'),
        shift('offered', counts: {'sent': 3, 'expired': 3}, sent: true),
      ]) {
        final look = sentShiftLook(row);
        expect(look.label, 'No active offers');
        expect(look.card, const Color(0xFFFAF9F6));
      }
    });
    test('old bright yellow/lavender card colours are gone', () {
      for (final status in [
        'pending_manager_approval',
        'offered',
        'declined',
        'cancelled',
        'completed',
        'open',
      ]) {
        final card = sentShiftLook(shift(status)).card;
        expect(card, isNot(const Color(0xFFFFDA79)));
        expect(card, isNot(const Color(0xFFDFE2FF)));
      }
    });
  });

  group('sentAgo', () {
    final now = DateTime(2025, 4, 26, 12);
    test('just now, minutes, hours, days, then a date', () {
      expect(
        sentAgo(now.subtract(const Duration(seconds: 20)), now),
        'Sent just now',
      );
      expect(
        sentAgo(now.subtract(const Duration(minutes: 5)), now),
        'Sent 5m ago',
      );
      expect(
        sentAgo(now.subtract(const Duration(hours: 2)), now),
        'Sent 2h ago',
      );
      expect(
        sentAgo(now.subtract(const Duration(days: 3)), now),
        'Sent 3d ago',
      );
      expect(sentAgo(DateTime(2025, 4, 12, 9), now), 'Sent 12 Apr 2025');
    });
    test('a future timestamp (clock skew) never reads negative', () {
      expect(
        sentAgo(now.add(const Duration(minutes: 3)), now),
        'Sent just now',
      );
    });
  });

  group('time formatting', () {
    test('date label', () {
      expect(sentShiftDate(DateTime(2025, 4, 26, 18)), 'Sat 26 Apr 2025');
    });
    test('overnight appends (+1); same-day does not', () {
      expect(
        sentShiftTimeRange(DateTime(2025, 4, 26, 18), DateTime(2025, 4, 27, 2)),
        '18:00 - 02:00 (+1)',
      );
      expect(
        sentShiftTimeRange(DateTime(2025, 4, 26, 9), DateTime(2025, 4, 26, 17)),
        '09:00 - 17:00',
      );
    });
  });

  testWidgets('Sent Shifts card renders the real state', (tester) async {
    final provider = VenueManagerProvider(ApiClient(), 'user-1');
    addTearDown(provider.dispose);
    final row = shift(
      'offered',
      counts: {'sent': 4, 'pending': 4},
      sent: true,
      submittedAt: DateTime(2025, 4, 26, 10).toIso8601String(),
    );
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: provider,
        child: MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: SentShiftCard(shift: row, now: DateTime(2025, 4, 26, 12)),
            ),
          ),
        ),
      ),
    );
    final card = find.byKey(const ValueKey('sent-shift-card-shift-1'));
    expect(card, findsOneWidget);
    for (final text in [
      'Pending',
      'Sent 2h ago',
      'The Riverside Hotel',
      'Bartender',
      'Sat 26 Apr 2025',
      '18:00 - 02:00 (+1)',
      'Sent to 4 staff',
    ]) {
      expect(
        find.descendant(of: card, matching: find.text(text)),
        findsOneWidget,
      );
    }
    expect(find.byIcon(Icons.north_east), findsOneWidget);
    expect(find.byTooltip('View sent shift'), findsOneWidget);
    final box = tester.widget<Container>(
      find.descendant(of: card, matching: find.byType(Container)).first,
    );
    expect((box.decoration as BoxDecoration).color, const Color(0xFFFDEEE6));
    expect(
      (box.decoration as BoxDecoration).borderRadius,
      BorderRadius.circular(20),
    );
  });

  testWidgets('a card with nothing sent says so and omits the age', (
    tester,
  ) async {
    final provider = VenueManagerProvider(ApiClient(), 'user-1');
    addTearDown(provider.dispose);
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: provider,
        child: MaterialApp(
          home: Scaffold(
            body: SentShiftCard(shift: shift('pending_manager_approval')),
          ),
        ),
      ),
    );
    expect(find.text('Not sent yet'), findsOneWidget);
    expect(find.text('Pending approval'), findsOneWidget);
    expect(find.textContaining('Sent '), findsNothing);
  });
}
