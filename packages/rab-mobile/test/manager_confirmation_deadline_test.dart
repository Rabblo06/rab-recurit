import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/models/notification_item.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/realtime/realtime_connection_service.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/calendar/calendar_presentation.dart';
import 'package:rab_staff/features/calendar/calendar_view.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/home/home_dashboard_data.dart';
import 'package:rab_staff/features/home/todays_shift.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';
import 'package:rab_staff/features/notifications/notifications_screen.dart';
import 'package:rab_staff/features/offers/offer_detail_ui_state.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/features/offers/schedule_offer_detail_screen.dart';
import 'package:rab_staff/features/offers/schedule_offers_screen.dart';
import 'package:rab_staff/features/offers/staff_shift_lifecycle.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_screens.dart';
import 'package:rab_staff/features/venue_manager/vm_offer_status.dart';

import 'support/biometric_test_support.dart';

/// Owner rule 2026-11-06: the system never auto-confirms. A STAFF_ACCEPTED
/// offer still unconfirmed at its approval deadline is withdrawn. The app
/// only DISPLAYS the server's projection (`approvalDeadlineAt`,
/// `awaitingManagerConfirmation`, `closedReason`, `canAccept`) and tolerates
/// all of it missing (a backend that predates the contract).

const _accept =
    'This shift starts too soon for a manager to confirm it, so it can no longer be accepted.';
const _acceptReplacement =
    'This shift has ended, so this offer can no longer be accepted.';

// Shift 2026-10-23 12:00–18:00 UTC (13:00–19:00 Europe/London; the test VM
// may run in any zone, so expectations use the same local formatting).
Map<String, dynamic> row({
  String id = 'o1',
  String status = 'staff_accepted',
  String? state = 'pending',
  String startsAt = '2026-10-23T12:00:00Z',
  String endsAt = '2026-10-23T18:00:00Z',
  Map<String, dynamic> extra = const {},
  Map<String, dynamic> presentationExtra = const {},
}) => {
  'id': id,
  'shiftId': 'shift-$id',
  'status': status,
  'sentAt': '2026-10-20T11:05:00Z',
  'expiresAt': '2026-10-22T11:05:00Z',
  'startsAt': startsAt,
  'endsAt': endsAt,
  'venueName': 'Riverside House',
  'roleName': 'Waiting staff',
  'staffProfileId': 'staff-$id',
  'staffName': 'Priya Shah',
  'payRatePence': 1350,
  'estimatedPayPence': 7425,
  if (state != null)
    'presentation': {
      'state': state,
      'homeLabel': 'Next Shift',
      'isToday': false,
      'serverNow': '2026-10-20T11:40:00Z',
      'nextTransitionAt': null,
      'clockInAt': null,
      ...presentationExtra,
    },
  ...extra,
};

Map<String, dynamic> awaitingRow({String id = 'o1'}) => row(
  id: id,
  extra: {
    'approvalDeadlineAt': '2026-10-23T11:30:00Z',
    'awaitingManagerConfirmation': true,
    'closedReason': null,
    'canAccept': false,
  },
  presentationExtra: {'closedReason': null, 'canAccept': false},
);

Map<String, dynamic> withdrawnRow({String id = 'o2'}) => row(
  id: id,
  status: 'manager_rejected',
  state: 'rejected',
  extra: {
    'approvalDeadlineAt': '2026-10-23T11:30:00Z',
    'awaitingManagerConfirmation': false,
    'closedReason': 'confirmation_deadline_passed',
    'managerRejectedAt': '2026-10-23T11:30:00Z',
    'rejectionReason': 'confirmation_deadline_passed',
    'canAccept': false,
  },
  presentationExtra: {
    'closedReason': 'confirmation_deadline_passed',
    'canAccept': false,
  },
);

/// Past the deadline but not yet withdrawn by the Worker: the server projects
/// it as rejected + `confirmation_deadline_passed` while status is still
/// staff_accepted.
Map<String, dynamic> projectedRow({String id = 'o3'}) => row(
  id: id,
  state: 'rejected',
  extra: {
    'approvalDeadlineAt': '2026-10-23T11:30:00Z',
    'awaitingManagerConfirmation': false,
    'closedReason': 'confirmation_deadline_passed',
  },
  presentationExtra: {'closedReason': 'confirmation_deadline_passed'},
);

Map<String, dynamic> confirmedRow({String id = 'o4'}) =>
    row(id: id, status: 'manager_confirmed', state: 'confirmed');

Map<String, dynamic> pendingRow({String id = 'o5', bool? canAccept}) => row(
  id: id,
  status: 'pending',
  extra: {
    'approvalDeadlineAt': '2026-10-23T11:30:00Z',
    'awaitingManagerConfirmation': false,
    'closedReason': null,
    'canAccept': ?canAccept,
  },
);

OfferSummary offer(Map<String, dynamic> json) => OfferSummary.fromJson(json);

String localTime(String iso) {
  final d = DateTime.parse(iso).toLocal();
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// A client answering `/offers/mine` with [rows] (and the attendance reads
/// the detail screen needs); [onPost] answers POSTs.
ApiClient api(
  List<Map<String, dynamic>> Function() rows, {
  http.Response Function(http.Request request)? onPost,
  List<String>? reads,
}) => ApiClient(
  httpClient: MockClient((request) async {
    final path = request.url.path;
    reads?.add('${request.method} $path');
    if (request.method == 'POST') {
      return onPost?.call(request) ?? http.Response('{}', 201);
    }
    if (path.endsWith('/offers/mine')) {
      return http.Response(jsonEncode(rows()), 200);
    }
    if (path.endsWith('/attendance/me/history')) {
      return http.Response('[]', 200);
    }
    if (path.endsWith('/attendance/me/active')) {
      return http.Response(
        jsonEncode({'attendance': null, 'serverNow': '2026-10-20T11:40:00Z'}),
        200,
      );
    }
    return http.Response('[]', 200);
  }),
);

void main() {
  setUp(() => stubSecureStorageChannel({}));
  tearDown(clearSecureStorageChannel);

  group('model and null tolerance', () {
    test('a backend without the fields keeps the previous behaviour', () {
      final legacy = offer(row());
      expect(legacy.approvalDeadlineAt, isNull);
      expect(legacy.awaitingManagerConfirmation, isNull);
      expect(legacy.closedReason, isNull);
      expect(legacy.canAccept, isNull);
      expect(legacy.presentation!.closedReason, isNull);
      expect(legacy.presentation!.canAccept, isNull);
      // staff_accepted still reads as awaiting a manager, never confirmed.
      expect(legacy.isAwaitingManagerConfirmation, isTrue);
      expect(legacy.withdrawnAtDeadline, isFalse);
      // No canAccept: unknown, so Accept stays.
      expect(offer(row(status: 'pending')).acceptRefused, isFalse);
      // A malformed value is ignored, not thrown.
      final odd = offer(
        row(
          extra: {
            'approvalDeadlineAt': 'not a date',
            'awaitingManagerConfirmation': 'yes',
            'closedReason': 7,
          },
        ),
      );
      expect(odd.approvalDeadlineAt, isNull);
      expect(odd.awaitingManagerConfirmation, isNull);
      expect(odd.closedReason, isNull);
    });

    test('awaiting, withdrawn and projected-past-deadline readings', () {
      final awaiting = offer(awaitingRow());
      expect(
        awaiting.approvalDeadlineAt,
        DateTime.parse('2026-10-23T11:30:00Z'),
      );
      expect(awaiting.isAwaitingManagerConfirmation, isTrue);
      expect(awaiting.withdrawnAtDeadline, isFalse);

      final withdrawn = offer(withdrawnRow());
      expect(withdrawn.withdrawnAtDeadline, isTrue);
      expect(withdrawn.isAwaitingManagerConfirmation, isFalse);
      expect(withdrawn.presentation!.label, 'Withdrawn');

      final projected = offer(projectedRow());
      expect(projected.status, 'staff_accepted');
      expect(projected.isAwaitingManagerConfirmation, isFalse);
      expect(projected.withdrawnAtDeadline, isTrue);

      // A server `false` alone is never awaiting.
      expect(
        offer(
          row(extra: {'awaitingManagerConfirmation': false}),
        ).isAwaitingManagerConfirmation,
        isFalse,
      );
      // Only the presentation carries the reason (row field missing).
      expect(
        offer(
          row(
            status: 'manager_rejected',
            state: 'rejected',
            presentationExtra: {'closedReason': 'confirmation_deadline_passed'},
          ),
        ).withdrawnAtDeadline,
        isTrue,
      );
      // An ordinary manager rejection stays "Not confirmed".
      final rejected = offer(
        row(status: 'manager_rejected', state: 'rejected'),
      );
      expect(rejected.withdrawnAtDeadline, isFalse);
      expect(rejected.presentation!.label, 'Not confirmed');
    });

    test('canAccept is display only and falls back to the presentation', () {
      expect(offer(pendingRow(canAccept: false)).acceptRefused, isTrue);
      expect(offer(pendingRow(canAccept: true)).acceptRefused, isFalse);
      expect(
        offer(
          row(status: 'pending', presentationExtra: {'canAccept': false}),
        ).acceptRefused,
        isTrue,
      );
      // Never applies to an offer that is not pending.
      expect(offer(awaitingRow()).acceptRefused, isFalse);
    });

    test('the deadline label is the server instant in local time', () {
      final deadline = DateTime.parse('2026-10-23T11:30:00Z');
      final start = DateTime.parse('2026-10-23T12:00:00Z');
      expect(
        approvalDeadlineTime(deadline, start),
        localTime('2026-10-23T11:30:00Z'),
      );
      // Another day: the date is spelled out.
      expect(
        approvalDeadlineTime(deadline, start.add(const Duration(days: 2))),
        contains(','),
      );
    });
  });

  group('staff lifecycle', () {
    test('detail state shows Withdrawn, awaiting reads as awaiting', () {
      OfferDetailUiState resolve(Map<String, dynamic> json) =>
          OfferDetailUiState.resolve(
            offer: offer(json),
            active: null,
            history: const [],
            clockableShiftId: null,
          );
      expect(resolve(withdrawnRow()), OfferDetailUiState.withdrawn);
      expect(resolve(projectedRow()), OfferDetailUiState.withdrawn);
      expect(
        resolve(withdrawnRow()..remove('presentation')),
        OfferDetailUiState.withdrawn,
      );
      expect(resolve(awaitingRow()), OfferDetailUiState.pending);
      expect(OfferDetailUiState.withdrawn.label, 'Withdrawn');
      expect(OfferDetailUiState.pending.label, 'Awaiting manager confirmation');
      expect(
        resolve(row(status: 'manager_rejected', state: 'rejected')),
        OfferDetailUiState.rejected,
      );
    });

    test('withdrawn offers leave Confirmed, Upcoming and Today', () {
      final now = DateTime.parse('2026-10-20T11:40:00Z');
      final rows = [
        offer(withdrawnRow()),
        offer(projectedRow()),
        offer(awaitingRow()),
        offer(confirmedRow()),
      ];
      expect(currentConfirmedShifts(rows, now: now).map((o) => o.id), ['o4']);
      final home = HomeDashboardData(rows, now: now);
      expect(home.upcoming.map((o) => o.id), ['o4']);
      expect(home.confirmed, 1);
      expect(
        todaysConfirmedOffer([offer(withdrawnRow()), offer(projectedRow())]),
        isNull,
      );
    });

    test('calendar includes withdrawn offers as Withdrawn (owner Q8)', () {
      expect(calendarIncludes(offer(withdrawnRow())), isTrue);
      expect(calendarStatus(offer(withdrawnRow())), CalendarStatus.withdrawn);
      expect(
        calendarStatus(offer(withdrawnRow()..remove('presentation'))),
        CalendarStatus.withdrawn,
      );
      expect(calendarStatus(offer(projectedRow())), CalendarStatus.withdrawn);
      expect(calendarStatus(offer(awaitingRow())), CalendarStatus.awaiting);
      expect(CalendarStatus.awaiting.label, 'Awaiting manager confirmation');
      // Other rejections stay out of the calendar.
      expect(
        calendarIncludes(
          offer(row(status: 'manager_rejected', state: 'rejected')),
        ),
        isFalse,
      );
    });

    testWidgets('calendar card shows the Withdrawn chip', (tester) async {
      final withdrawn = offer(withdrawnRow());
      final awaiting = offer(awaitingRow(id: 'o6'));
      CalendarItem item(OfferSummary o) => CalendarItem(
        offer: o,
        status: calendarStatus(o),
        color: const Color(0xFFDCEAFB),
      );
      tester.view.physicalSize = const Size(393, 852);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildLightTheme(),
          home: Scaffold(
            body: StaffCalendarView(
              items: [item(withdrawn), item(awaiting)],
              now: DateTime(2026, 10, 23),
              onOpen: (_) {},
              onProfile: () {},
              onRefresh: () async {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('calendar-withdrawn-o2')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('calendar-withdrawn-o6')), findsNothing);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('calendar-withdrawn-o2')),
          matching: find.text('Withdrawn'),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('staff screens', () {
    Future<OffersProvider> mountList(
      WidgetTester tester,
      List<Map<String, dynamic>> rows, {
      bool confirmed = false,
    }) async {
      final offers = OffersProvider(api(() => rows));
      await tester.runAsync(() => offers.load());
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: offers,
          child: MaterialApp(
            theme: buildLightTheme(),
            home: ScheduleOffersScreen(confirmed: confirmed),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return offers;
    }

    testWidgets('Offers: awaiting with the server deadline; withdrawn gone', (
      tester,
    ) async {
      final offers = await mountList(tester, [
        awaitingRow(),
        withdrawnRow(),
        projectedRow(),
        pendingRow(canAccept: false),
      ]);
      expect(find.text('Awaiting manager confirmation'), findsOneWidget);
      expect(
        find.text(
          'Needs manager confirmation by ${localTime('2026-10-23T11:30:00Z')}',
        ),
        findsOneWidget,
      );
      // Withdrawn (and projected past the deadline) never appear as offers.
      expect(find.byKey(const ValueKey('offer-deadline-o2')), findsNothing);
      expect(find.byKey(const ValueKey('offer-deadline-o3')), findsNothing);
      expect(find.text('Waiting staff'), findsNWidgets(2));
      // canAccept false: Accept is replaced by a disabled "Too late to accept".
      expect(find.text('Accept'), findsNothing);
      final late = tester.widget<FilledButton>(
        find.ancestor(
          of: find.text('Too late to accept'),
          matching: find.byType(FilledButton),
        ),
      );
      expect(late.onPressed, isNull);
      // No text promises an automatic confirmation.
      expect(find.textContaining('automatic'), findsNothing);
      expect(find.textContaining('auto-confirm'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      offers.dispose();
    });

    testWidgets('Offers: Accept stays when canAccept is missing', (
      tester,
    ) async {
      final offers = await mountList(tester, [pendingRow()]);
      expect(find.text('Accept'), findsOneWidget);
      expect(find.text('Too late to accept'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      offers.dispose();
    });

    testWidgets('Confirmed never lists a withdrawn offer', (tester) async {
      final offers = await mountList(tester, [
        withdrawnRow(),
        projectedRow(),
        awaitingRow(),
      ], confirmed: true);
      expect(find.text('No confirmed shifts'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      offers.dispose();
    });

    Future<void> mountDetail(
      WidgetTester tester,
      Map<String, dynamic> json,
    ) async {
      final client = api(() => [json]);
      final offers = OffersProvider(client);
      final attendance = AttendanceProvider(client);
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
            home: ScheduleOfferDetailScreen(offer: offer(json)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      addTearDown(() {
        offers.dispose();
        attendance.dispose();
      });
    }

    testWidgets('detail shows the withdrawal with the owner\'s sentence', (
      tester,
    ) async {
      await mountDetail(tester, withdrawnRow());
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('shift-status-control')),
          matching: find.text('Withdrawn'),
        ),
        findsOneWidget,
      );
      expect(find.text(ConfirmationDeadlineCopy.staffDetail), findsOneWidget);
      expect(find.text('Accept'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('detail shows awaiting with the server deadline', (
      tester,
    ) async {
      await mountDetail(tester, awaitingRow());
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('shift-status-control')),
          matching: find.text('Awaiting manager confirmation'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('detail-confirmation-note')),
        findsOneWidget,
      );
      expect(
        find.textContaining(localTime('2026-10-23T11:30:00Z')),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('detail: no deadline from an older server, no note', (
      tester,
    ) async {
      await mountDetail(tester, row());
      expect(
        find.byKey(const ValueKey('detail-confirmation-note')),
        findsNothing,
      );
      expect(find.text('Awaiting manager confirmation'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('409 on accept', () {
    test('the server message is shown for CONFIRMATION_DEADLINE_PASSED', () {
      for (final message in [_accept, _acceptReplacement]) {
        final e = ApiException(
          409,
          message,
          body: {
            'statusCode': 409,
            'code': confirmationDeadlinePassedCode,
            'message': message,
          },
        );
        expect(OffersProvider.responseFailureMessage(e), message);
      }
      // Other errors keep the normal filter.
      expect(
        OffersProvider.responseFailureMessage(ApiException(500, 'boom')),
        ApiMessages.serverError,
      );
    });

    test(
      'accept refused: message kept, offer re-read, nothing changed',
      () async {
        final reads = <String>[];
        final client = api(
          () => [pendingRow()],
          reads: reads,
          onPost: (_) => http.Response(
            jsonEncode({
              'statusCode': 409,
              'code': 'CONFIRMATION_DEADLINE_PASSED',
              'message': _accept,
            }),
            409,
          ),
        );
        final offers = OffersProvider(client);
        await offers.load();
        final before = reads.where((r) => r.endsWith('/offers/mine')).length;
        await offers.respond('o5', 'accept');
        expect(offers.errorOfferId, 'o5');
        expect(offers.errorMessage, _accept);
        expect(
          reads.where((r) => r.endsWith('/offers/mine')).length,
          greaterThan(before),
        );
        expect(offers.offers.single.status, 'pending');
        offers.dispose();
      },
    );
  });

  group('Venue Manager', () {
    test('a withdrawn person never reads as accepted or confirmed', () {
      String label(Map<String, dynamic> json) =>
          vmOfferLabel(offer(json), offerStatus);
      expect(label(withdrawnRow()), 'Not confirmed in time');
      expect(label(projectedRow()), 'Not confirmed in time');
      expect(label(awaitingRow()), 'Waiting for Manager Confirmation');
      expect(
        label(
          row(
            status: 'manager_rejected',
            state: null,
            extra: {'closedReason': 'shift_cancelled'},
          ),
        ),
        'Shift cancelled',
      );
      // Older server: plain status wording.
      expect(
        label(row(status: 'manager_rejected', state: null)),
        'Manager rejected',
      );
      expect(
        vmConfirmationDue(offer(awaitingRow())),
        'Manager confirmation due by ${localTime('2026-10-23T11:30:00Z')}',
      );
      expect(vmConfirmationDue(offer(withdrawnRow())), isNull);
      expect(vmConfirmationDue(offer(row())), isNull);
    });

    test('confirmed counts and teams exclude withdrawn rows', () {
      final p = VenueManagerProvider(api(() => []), 'vm-1');
      p.offers = [
        offer(withdrawnRow()),
        offer(projectedRow()),
        offer(awaitingRow()),
        offer(confirmedRow()),
      ];
      expect(p.confirmed.map((o) => o.id), ['o4']);
      expect(p.confirmedPeople, 1);
      p.dispose();
    });

    test('offer.rejected (the withdrawal event) refreshes the VM lists', () {
      expect(
        realtimeRefreshesFor(
          {'offer.rejected'},
          staff: false,
          venueManager: true,
        ),
        {RealtimeRefresh.venueManager},
      );
      expect(
        realtimeRefreshesFor(
          {'offer.rejected'},
          staff: true,
          venueManager: false,
        ),
        {RealtimeRefresh.offers},
      );
    });

    test('only manager_confirmation_timeout deep-links (Sent Shifts)', () {
      NotificationItem n(String type) => NotificationItem(
        id: 'n',
        type: type,
        title: 't',
        message: 'm',
        createdAt: DateTime(2026, 10, 23),
      );
      final context = _FakeContext();
      expect(
        vmNotificationTarget(context, n('shift_request_approved')),
        isNull,
      );
      expect(vmNotificationTarget(context, n('offer_rejected')), isNull);
      expect(
        vmNotificationTarget(context, n('manager_confirmation_timeout')),
        isNotNull,
      );
    });

    testWidgets('the timeout notification renders and opens its target', (
      tester,
    ) async {
      final client = ApiClient(
        httpClient: MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/notifications/unread-count')) {
            return http.Response('{"count":1}', 200);
          }
          if (path.endsWith('/notifications')) {
            return http.Response(
              jsonEncode([
                {
                  'id': 'n1',
                  'type': 'manager_confirmation_timeout',
                  'title': 'Confirmation deadline passed',
                  'message':
                      'The manager-confirmation deadline has passed. The pending staff assignment has been withdrawn and may require replacement.',
                  'readAt': null,
                  'createdAt': '2026-10-23T11:30:00Z',
                },
                {
                  'id': 'n2',
                  'type': 'shift_request_approved',
                  'title': 'Shift request approved',
                  'message': 'Approved.',
                  'readAt': '2026-10-20T11:20:00Z',
                  'createdAt': '2026-10-20T11:05:00Z',
                },
              ]),
              200,
            );
          }
          return http.Response('{}', 200);
        }),
      );
      final notifications = NotificationsProvider(client);
      final opened = <String>[];
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: notifications,
          child: MaterialApp(
            theme: buildLightTheme(),
            home: NotificationsScreen(
              targetFor: (context, n) =>
                  n.type == 'manager_confirmation_timeout'
                  ? () => opened.add(n.id)
                  : null,
            ),
          ),
        ),
      );
      await tester.runAsync(() => notifications.load());
      await tester.pumpAndSettle();
      expect(find.text('Confirmation deadline passed'), findsOneWidget);
      expect(
        find.text(
          'The manager-confirmation deadline has passed. The pending staff assignment has been withdrawn and may require replacement.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Confirmation deadline passed'));
      await tester.tap(find.text('Shift request approved'));
      await tester.pump();
      expect(opened, ['n1']);
      await tester.pumpWidget(const SizedBox());
      notifications.dispose();
    });
  });
}

/// [vmNotificationTarget] only reads the context when the returned callback
/// runs; this test never runs it.
class _FakeContext extends Fake implements BuildContext {}
