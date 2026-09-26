import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/home/home_dashboard_data.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/features/offers/schedule_offer_detail_screen.dart';
import 'support/biometric_test_support.dart';

Map<String, dynamic> fixture(
  String state, {
  int elapsed = 1,
  String? note,
  bool today = true,
}) => {
  'id': 'offer',
  'shiftId': 'shift',
  'status': state == 'pending' ? 'staff_accepted' : 'manager_confirmed',
  'sentAt': '2026-09-22T08:00:00Z',
  'expiresAt': '2026-09-23T08:00:00Z',
  'startsAt': '2026-09-22T09:00:00Z',
  'endsAt': '2026-09-22T17:00:00Z',
  'venueName': 'QA Venue',
  'roleName': 'QA Bartender',
  'staffProfileId': 'staff',
  'staffName': 'QA Staff',
  'payRatePence': 1500,
  'estimatedPayPence': 12000,
  'venueAddress': 'QA Address',
  'shiftNotes': note,
  'presentation': {
    'state': state,
    'homeLabel': state == 'live'
        ? 'Live Shift'
        : today
        ? "Today's Shift"
        : 'Next Shift',
    'isToday': today,
    'serverNow': DateTime.utc(
      2026,
      9,
      22,
      9,
    ).add(Duration(seconds: elapsed)).toIso8601String(),
    'clockInAt': state == 'live' ? '2026-09-22T09:00:00Z' : null,
    'nextTransitionAt': null,
  },
};
void main() {
  setUp(() => stubSecureStorageChannel({}));
  tearDown(clearSecureStorageChannel);
  for (final sample in <(String, String, int)>[
    ('pending', 'Pending', 1),
    ('confirmed', 'Confirmed', 1),
    ('live', '00:00:01', 1),
    ('live', '01:01:01', 3661),
    ('clockedOut', 'Clocked Out', 1),
    ('complete', 'Complete', 1),
    ('expired', 'Expired', 1),
    ('reconciling', 'Updating status', 1),
  ]) {
    testWidgets('Details central state ${sample.$1} ${sample.$2}', (
      tester,
    ) async {
      final json = fixture(
        sample.$1 == 'reconciling' ? 'live' : sample.$1,
        elapsed: sample.$3,
      );
      final api = ApiClient(
        httpClient: MockClient(
          (request) async => http.Response(
            jsonEncode(
              request.url.path.endsWith('/offers/mine')
                  ? [json]
                  : request.url.path.endsWith('/attendance/me/history')
                  ? (sample.$1 == 'reconciling'
                        ? [
                            {
                              ...json,
                              'id': 'attendance',
                              'status': 'clocked_out',
                              'clockInAt': '2026-09-22T09:00:00Z',
                              'clockOutAt': '2026-09-22T09:00:01Z',
                            },
                          ]
                        : [])
                  : {
                      'attendance': null,
                      'serverNow': json['presentation']['serverNow'],
                    },
            ),
            200,
          ),
        ),
      );
      final offers = OffersProvider(api), attendance = AttendanceProvider(api);
      await tester.runAsync(() async {
        await offers.load();
        await attendance.refreshActive();
        await attendance.loadHistory();
      });
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider.value(value: offers),
            ChangeNotifierProvider.value(value: attendance),
          ],
          child: MaterialApp(
            theme: buildLightTheme(),
            home: ScheduleOfferDetailScreen(offer: OfferSummary.fromJson(json)),
          ),
        ),
      );
      if (sample.$1 == 'reconciling') {
        await tester.pump(const Duration(milliseconds: 100));
      } else {
        await tester.pumpAndSettle();
      }
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('shift-status-control')),
          matching: find.text(sample.$2),
        ),
        findsOneWidget,
      );
      expect(find.text('Be Ready'), findsNothing);
      expect(find.text('Back to shifts'), findsNothing);
      if (const ['clockedOut', 'complete', 'expired'].contains(sample.$1)) {
        expect(find.text(sample.$2), findsOneWidget);
      }
      expect(find.text('NOTE'), findsOneWidget);
      expect(find.text('No Details'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      offers.dispose();
      attendance.dispose();
    });
  }
  test('Home picks authoritative live before today and future', () {
    final next = OfferSummary.fromJson({
      ...fixture('confirmed', today: false),
      'id': 'next',
      'shiftId': 'next',
      'startsAt': '2099-01-01T09:00:00Z',
    });
    final today = OfferSummary.fromJson(fixture('confirmed'));
    final live = OfferSummary.fromJson({
      ...fixture('live'),
      'id': 'live',
      'shiftId': 'live',
    });
    expect(HomeDashboardData([next, today, live]).primary?.id, 'live');
    expect(HomeDashboardData([next, today]).primary?.id, 'offer');
    expect(HomeDashboardData([next]).primary?.id, 'next');
  });
}
