import 'package:rab_staff/navigation/moving_tab_bar.dart';
import 'dart:convert';
import 'dart:async';
import 'package:rab_staff/features/venue_manager/send_shift_screen.dart';
import 'package:rab_staff/features/venue_manager/sent_shifts_screen.dart';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/models/current_user.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';
import 'package:rab_staff/features/venue_manager/report_lists.dart';
import 'package:rab_staff/features/venue_manager/shift_report_screen.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_screens.dart';
import 'package:rab_staff/navigation/app_shell.dart';
import 'package:rab_staff/navigation/console_entry_screen.dart';
import 'support/biometric_test_support.dart';

class VenueFixture {
  String role = 'venue_manager';
  String offerRole = 'Bartender';
  bool admin = false, fail = false, sendAllowed = false, failTags = false;
  // A revoked permission: every capabilities read answers 403.
  bool denied = false;
  bool completedFirst = false;
  bool reportView = true;
  String notes = 'Please use the staff entrance. Bring your staff ID.';
  String? firstShiftStatus;
  bool historical = false;
  final paths = <String>[];
  final posted = <String>[];
  int staffCount = 3;
  // Directory query strings, tag PATCH bodies and any call to the removed
  // discovery/self-add endpoints (which must never happen).
  final directoryQueries = <Map<String, String>>[];
  final tagBodies = <Map<String, dynamic>>[];
  final removedEndpointCalls = <String>[];
  final favourites = <String>{};
  final emergencies = <String>{};
  final unassigned = <String>{};
  int status403 = 0;
  static const names = ['Alice', 'Sam', 'Jordan', 'Taylor', 'Morgan'];
  Map<String, dynamic> profile(int i) => {
    'id': 'staff-$i',
    'firstName': names[i],
    'lastName': 'Example',
    'jobRoleName': i == 2 ? null : 'Bartender',
    'employmentType': i == 0 ? 'full_time' : null,
    'yearsExperience': null,
    'skills': i == 0 ? ['Cocktails', 'Cash handling'] : <String>[],
    'availableDays': i == 0 ? ['Monday', 'Friday'] : <String>[],
    'preferredShiftTimes': null,
    'maxHoursPerWeek': i == 0 ? 30 : null,
    'isFavourite': favourites.contains('staff-$i'),
    'isEmergency': emergencies.contains('staff-$i'),
  };

  /// Every `bucket=` the app asked for (Reports / History lists and counts).
  final reportBuckets = <String>[];

  /// Server-shaped `ShiftReportSummary` for one fixture shift.
  Map<String, dynamic> reportSummary(Map<String, dynamic> s) => {
    'shiftId': s['id'],
    'venueName': 'The Riverside Hotel',
    'roleName': 'Bartender',
    'startsAt': s['startsAt'],
    'endsAt': s['endsAt'],
    'shiftStatus': s['status'],
    'requiredCount': s['requiredCount'],
    'filledCount': s['filledCount'],
    'staffCount': s['filledCount'],
    'clockedOut': 0,
    'noShows': 0,
    'reportStatus': historical ? 'finalised' : 'pending',
    'lifecycle': {
      'displayStatus': historical ? 'sent' : 'waiting_clock_in',
      'displayLabel': historical ? 'Sent' : 'Waiting for clock-in',
      'actionExpiresAt': s['endsAt'],
      'actionExpired': historical,
      'needsAttendanceReview': false,
      'needsAttention': false,
      'deliveryState': historical ? 'sent' : 'not_finalised',
      'sentAt': null,
      'historyAt': null,
    },
  };
  /// Every shift id whose report was requested, and an optional override
  /// for the report body (Confirmed staff / Event Details fixtures).
  final reportRequests = <String>[];
  Map<String, dynamic> Function(String path)? reportOverride;
  bool sendFails = false;
  Completer<void>? sending;
  Map<String, dynamic>? sentBody;
  List<Map<String, dynamic>> get shifts => List.generate(
    4,
    (i) => {
      'id': 'shift-$i',
      'createdBy': sendAllowed ? 'user-1' : 'manager',
      'venueId': 'venue-1',
      'jobRoleId': 'role-1',
      'startsAt': DateTime.now()
          .add(Duration(days: historical ? -i - 2 : i, hours: 1))
          .toIso8601String(),
      'endsAt': DateTime.now()
          .add(Duration(days: historical ? -i - 2 : i, hours: 8))
          .toIso8601String(),
      'requiredCount': 20,
      'filledCount': i + 3,
      'status': i == 0 && firstShiftStatus != null
          ? firstShiftStatus
          : historical || (completedFirst && i == 0)
          ? 'completed'
          : 'partially_filled',
      'address': '12 High Street, Bristol, BS1 2AB',
      'notes': notes,
    },
  );
  List<Map<String, dynamic>> get offers => List.generate(
    3,
    (i) => {
      'id': 'offer-$i',
      'shiftId': 'shift-0',
      'staffProfileId': 'staff-$i',
      'staffName': ['Alice Example', 'Sam Green', 'Jordan Lee'][i],
      'status': i == 0 ? 'staff_accepted' : 'manager_confirmed',
      'sentAt': DateTime.now().toIso8601String(),
      'expiresAt': DateTime.now()
          .add(const Duration(days: 1))
          .toIso8601String(),
      'startsAt': shifts.first['startsAt'],
      'endsAt': shifts.first['endsAt'],
      'venueName': 'The Riverside Hotel',
      'roleName': offerRole,
      'payRatePence': 1222,
      'estimatedPayPence': 8554,
    },
  );
  List<Map<String, dynamic>>? sentOverride;
  List<Map<String, dynamic>> get sent =>
      sentOverride ??
      [
        {
          ...shifts.first,
          'roleName': offerRole,
          'venueName': 'The Riverside Hotel',
          'statusLabel': 'Staff responses received',
          'submittedAt': DateTime.now()
              .subtract(const Duration(hours: 2))
              .toIso8601String(),
          'offerCounts': {
            'sent': 3,
            'pending': 0,
            'accepted': 1,
            'confirmed': 2,
            'declined': 0,
          },
          'filters': ['staff_accepted'],
          'counters': {'sent': true, 'accepted': true, 'confirmed': false},
        },
      ];
  late final api = ApiClient(
    httpClient: MockClient((r) async {
      final path = r.url.path.replaceFirst('/rest/v1', '');
      paths.add(path);
      dynamic body;
      if (path == '/auth/login') {
        expect(
          (jsonDecode(r.body) as Map).keys,
          unorderedEquals(['email', 'password']),
        );
        body = {'accessToken': 'test', 'refreshToken': 'test'};
      } else if (path == '/auth/logout') {
        body = {};
      } else if (path == '/auth/me') {
        body = {
          ...fakeUserJson(),
          'roles': [role],
          'isPlatformAdmin': admin,
        };
      } else if (path == '/auth/capabilities') {
        if (denied) return http.Response('{"message":"Forbidden"}', 403);
        body = {
          'schedule.view': true,
          'venue.view': true,
          'staff.view': true,
          'report.view': reportView,
          'offer.send': sendAllowed,
          'staffing_request.create': sendAllowed,
        };
      } else if (path == '/attendance/report/shifts') {
        if (fail) {
          return http.Response('{"message":"Reports unavailable"}', 503);
        }
        final bucket = r.url.queryParameters['bucket'];
        reportBuckets.add(bucket!);
        final rows = (historical ? bucket == 'history' : bucket == 'current')
            ? shifts.map(reportSummary).toList()
            : <Map<String, dynamic>>[];
        body = {
          'data': rows,
          'total': rows.length,
          'serverNow': DateTime.now().toUtc().toIso8601String(),
        };
      } else if (path.startsWith('/attendance/report/shift/')) {
        // The report of the shift that was asked for (never another one).
        reportRequests.add(path.split('/')[4]);
        if (reportOverride != null) {
          return http.Response(jsonEncode(reportOverride!(path)), 200);
        }
        body = {
          'shiftId': path.split('/')[4],
          'venueName': 'The Riverside Hotel',
          'roleName': 'Bartender',
          'startsAt': shifts.first['startsAt'],
          'endsAt': shifts.first['endsAt'],
          'reportStatus': 'draft',
          'staff': [
            {
              'staffProfileId': 'staff-0',
              'staffName': 'Alice Example',
              'roleName': 'Bartender',
              'assignmentStatus': 'completed',
              'attendanceId': 'attendance-0',
              'attendanceStatus': 'clocked_out',
              'clockInAt': '2026-09-22T11:52:04Z',
              'clockOutAt': '2026-09-22T11:53:12Z',
              'breakMinutes': 0,
              'scheduledBreakMinutes': 0,
              'workedMinutes': 1,
              'earnedPence': '25',
              'locationVerified': true,
            },
          ],
        };
      } else if (path == '/shifts') {
        if (fail) {
          return http.Response('{"message":"Schedule unavailable"}', 503);
        }
        body = {'data': shifts, 'total': 4};
      } else if (path == '/shifts/sent') {
        // Mirrors the server contract: `view` is classified server-side (All never contains expired requests), and
        // `counts` carries every tab's total plus `submitted` (distinct requests, one per shift).
        const tabFilter = {
          'pending': 'pending',
          'accepted': 'staff_accepted',
          'confirmed': 'manager_confirmed',
          'declined': 'declined',
          'expired': 'expired',
        };
        bool inView(Map<String, dynamic> row, String view) {
          final filters = (row['filters'] as List?)?.cast<String>() ?? const [];
          return view == 'all'
              ? !filters.contains('expired')
              : filters.contains(tabFilter[view]);
        }

        final view = r.url.queryParameters['view'] ?? 'all';
        final rows = sent.where((row) => inView(row, view)).toList();
        body = {
          'data': rows,
          'total': rows.length,
          'view': view,
          'counts': {
            for (final v in ['all', ...tabFilter.keys])
              v: sent.where((row) => inView(row, v)).length,
            'submitted': sent.length,
          },
        };
      } else if (path.startsWith('/shifts/sent/') && r.method == 'GET') {
        final row = sent
            .where((row) => row['id'] == path.split('/')[3])
            .firstOrNull;
        if (row == null) {
          return http.Response('{"message":"Shift not found."}', 404);
        }
        body = row;
      } else if (path.startsWith('/shifts/') && r.method == 'GET') {
        body = shifts.firstWhere((s) => s['id'] == path.split('/')[2]);
      } else if (path == '/venues') {
        body = {
          'data': [
            {'id': 'venue-1', 'name': 'The Riverside Hotel'},
          ],
          'total': 1,
        };
      } else if (path == '/job-roles') {
        body = [
          {'id': 'role-1', 'name': 'Bartender'},
        ];
      } else if (path == '/offers') {
        body = {'data': offers, 'total': 3};
      } else if (path == '/staff/venue-directory') {
        final params = r.url.queryParameters;
        directoryQueries.add(params);
        if (status403 > 0) {
          status403--;
          return http.Response('{"message":"Forbidden"}', 403);
        }
        final query = params['q'] ?? '';
        final tag = params['tag'];
        final windowed =
            params.containsKey('startAt') && params.containsKey('endAt');
        final rows = [
          for (var i = 0; i < staffCount; i++)
            if (!unassigned.contains('staff-$i'))
              {
                'id': 'staff-$i',
                'firstName': names[i],
                'lastName': 'Example',
                'employmentStatus': 'active',
                'jobRoleName': i == 2 ? null : 'Bartender',
                'isFavourite': favourites.contains('staff-$i'),
                'isEmergency': emergencies.contains('staff-$i'),
                // Present only for a real evaluated window (API contract).
                if (windowed) 'available': i != 1,
              },
        ];
        final filtered = rows
            .where(
              (u) =>
                  (u['firstName'] as String).toLowerCase().contains(
                    query.toLowerCase(),
                  ) &&
                  (tag == null ||
                      (tag == 'favourite' && u['isFavourite'] == true) ||
                      (tag == 'emergency' && u['isEmergency'] == true)),
            )
            .toList();
        body = {'data': filtered, 'total': filtered.length};
      } else if (path == '/staff/venue-directory/pool' ||
          path.startsWith('/staff/venue-directory/team')) {
        removedEndpointCalls.add('${r.method} $path');
        return http.Response('{"message":"Not Found"}', 404);
      } else if (path.startsWith('/staff/venue-directory/')) {
        final parts = path.split('/');
        final id = parts[3];
        final i = int.parse(id.split('-').last);
        if (unassigned.contains(id) || i >= staffCount) {
          return http.Response('{"message":"Not Found"}', 404);
        }
        if (parts.length == 5 && parts[4] == 'tags' && r.method == 'PATCH') {
          if (failTags) {
            return http.Response('{"message":"Internal server error"}', 500);
          }
          final tags = jsonDecode(r.body) as Map<String, dynamic>;
          tagBodies.add(tags);
          for (final (key, set) in [
            ('favourite', favourites),
            ('emergency', emergencies),
          ]) {
            if (tags[key] == true) set.add(id);
            if (tags[key] == false) set.remove(id);
          }
          body = {
            'isFavourite': favourites.contains(id),
            'isEmergency': emergencies.contains(id),
          };
        } else {
          body = profile(i);
        }
      } else if (path == '/shifts/request') {
        posted.add(path);
        sentBody = jsonDecode(r.body) as Map<String, dynamic>;
        if (sending != null) await sending!.future;
        if (sendFails) return http.Response('{"message":"Unavailable"}', 503);
        body = {
          'id': 'new-shift',
          'results': [
            for (final id in sentBody!['staffProfileIds'] as List)
              {'staffProfileId': id, 'ok': true},
          ],
        };
      } else if (path.endsWith('/offers/bulk')) {
        posted.add(path);
        final ids = (jsonDecode(r.body)['staffProfileIds'] as List);
        body = {
          'results': [
            for (final id in ids)
              {
                'staffProfileId': id,
                'ok': id != 'staff-2',
                'message': id == 'staff-2' ? 'Already offered' : null,
              },
          ],
        };
      } else if (path == '/notifications/unread-count') {
        body = {'count': 0};
      } else if (path == '/attendance/me/active') {
        body = {'attendance': null};
      } else {
        body = [];
      }
      return http.Response(jsonEncode(body), 200);
    }),
  );
}

/// The longest gap between two Sent Shifts polls: interval + 20 % jitter.
final sentPollGap =
    VenueSentShiftsScreen.pollInterval * 1.2 + const Duration(seconds: 1);

void main() {
  final boundary = GlobalKey();
  setUp(
    () => stubSecureStorageChannel({
      'rab.accessToken': 'test',
      'rab.refreshToken': 'test',
    }),
  );
  tearDown(clearSecureStorageChannel);
  setUpAll(() async {
    final fonts =
        '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts';
    for (final entry in {
      'Roboto': 'roboto-regular.ttf',
      'MaterialIcons': 'materialicons-regular.otf',
    }.entries) {
      final loader = FontLoader(entry.key)
        ..addFont(
          File(
            '$fonts/${entry.value}',
          ).readAsBytes().then((b) => ByteData.sublistView(b)),
        );
      await loader.load();
    }
  });
  Future<void> shot(WidgetTester tester, String name) async {
    expect(tester.takeException(), isNull);
    if (!const bool.fromEnvironment('VM_VISUAL_CAPTURE')) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory('.qa-screenshots/venue-manager').create(recursive: true);
      await File(
        '.qa-screenshots/venue-manager/$name.png',
      ).writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  Future<VenueManagerProvider> mount(
    WidgetTester tester,
    VenueFixture f, {
    Widget? page,
    Size size = const Size(393, 852),
    double scale = 1,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final auth = AuthProvider(
      apiClient: f.api,
      biometricAuthenticator: FakeBiometricAuthenticator(),
    );
    final p = VenueManagerProvider(f.api, 'user-1');
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider.value(value: auth),
          ChangeNotifierProvider.value(value: p),
          ChangeNotifierProvider(create: (_) => NotificationsProvider(f.api)),
        ],
        child: MaterialApp(
          theme: buildLightTheme().copyWith(
            textTheme: buildLightTheme().textTheme.apply(fontFamily: 'Roboto'),
            primaryTextTheme: buildLightTheme().primaryTextTheme.apply(
              fontFamily: 'Roboto',
            ),
          ),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
              padding: const EdgeInsets.only(top: 24, bottom: 24),
            ),
            child: RepaintBoundary(key: boundary, child: child),
          ),
          home: const VenueManagerShell(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    if (page != null) {
      Navigator.of(
        tester.element(find.byType(VenueManagerHome)),
      ).push(MaterialPageRoute<void>(builder: (_) => page));
      await tester.pumpAndSettle();
    }
    addTearDown(() {
      auth.dispose();
      p.dispose();
    });
    return p;
  }

  test(
    'history excludes future, requests, active offers and unstaffed shifts',
    () {
      final now = DateTime.utc(2026, 9, 29);
      final p = VenueManagerProvider(VenueFixture().api, 'user-1');
      addTearDown(p.dispose);
      VenueEvent event(String id, String status, int filled, DateTime end) =>
          VenueEvent(
            {
              'id': id,
              'status': status,
              'startsAt': end
                  .subtract(const Duration(hours: 8))
                  .toIso8601String(),
              'endsAt': end.toIso8601String(),
              'filledCount': filled,
              'requiredCount': 3,
            },
            role: 'Chef',
            venue: 'Scoped venue',
          );
      final past = now.subtract(const Duration(days: 1));
      p.events = [
        event('completed', 'completed', 2, past),
        event('confirmed', 'confirmed', 2, now),
        event('partial', 'partially_filled', 1, past),
        event('future', 'completed', 2, now.add(const Duration(days: 1))),
        for (final status in [
          'draft',
          'open',
          'offered',
          'pending_manager_approval',
          'cancelled',
          'declined',
          'in_progress',
        ])
          event(status, status, 2, past),
        event('empty', 'partially_filled', 0, past),
      ];
      expect(p.history(now: now).map((e) => e.id), [
        'confirmed',
        'completed',
        'partial',
      ]);
    },
  );

  testWidgets(
    'History owns the third tab, preserves detail state and system Back',
    (tester) async {
      final f = VenueFixture()..historical = true;
      await mount(tester, f);
      for (final label in ['Home', 'Calendar', 'History', 'Profile']) {
        expect(
          find.descendant(
            of: find.byType(MovingTabBar),
            matching: find.byTooltip(label),
          ),
          findsOneWidget,
        );
      }
      expect(find.byTooltip('Offers'), findsNothing);
      await tester.tap(find.byTooltip('History'));
      await tester.pumpAndSettle();
      expect(find.byType(VenueHistoryScreen), findsOneWidget);
      expect(find.text('Sent Shifts'), findsNothing);
      // Server-filtered History (five-hour policy), never a client-side filter over every shift.
      expect(f.reportBuckets, contains('history'));
      expect(
        find.byKey(const ValueKey('report-event-card-shift-0')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('report-event-card-shift-0')));
      await tester.pumpAndSettle();
      expect(find.byType(ShiftReportScreen), findsOneWidget);
      expect(find.byType(MovingTabBar), findsNothing);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(ShiftReportScreen), findsNothing);
      expect(find.byType(VenueHistoryScreen), findsOneWidget);
      expect(find.byType(MovingTabBar), findsOneWidget);
      expect(f.paths.any((p) => p.contains('/staff/history')), isFalse);
      final list = find.byKey(const PageStorageKey('reports-history'));
      await tester.drag(list, const Offset(0, -250));
      await tester.pumpAndSettle();
      final scroll = tester.state<ScrollableState>(
        find.descendant(of: list, matching: find.byType(Scrollable)),
      );
      final offset = scroll.position.pixels;
      expect(offset, greaterThan(0));
      await tester.tap(find.byTooltip('Calendar'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('History'));
      await tester.pumpAndSettle();
      expect(scroll.position.pixels, offset);
      expect(find.byType(MovingTabBar), findsOneWidget);
      await shot(tester, 'history-navigation');
    },
  );

  testWidgets(
    'My Space lists History beside Reports with server counts and opens the same History screen',
    (tester) async {
      final f = VenueFixture()..historical = true;
      await mount(tester, f);
      await tester.tap(find.text('My Space'));
      await tester.pumpAndSettle();
      // Counts come from the server lists (limit=1 totals), not from every shift on the phone.
      expect(f.reportBuckets, containsAll(['current', 'history']));
      await tester.ensureVisible(find.text('History').last);
      final historyRow = find.ancestor(
        of: find.text('History').last,
        matching: find.byType(ListTile),
      );
      expect(
        find.descendant(of: historyRow, matching: find.text('4')),
        findsOneWidget,
      );
      final reportsRow = find.ancestor(
        of: find.text('Reports'),
        matching: find.byType(ListTile),
      );
      expect(
        find.descendant(of: reportsRow, matching: find.text('0')),
        findsOneWidget,
      );
      await tester.tap(historyRow);
      await tester.pumpAndSettle();
      expect(find.byType(VenueHistoryScreen), findsOneWidget);
      expect(
        find.byKey(const ValueKey('report-event-card-shift-0')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'Home Staffing requests remains reachable and History clears denied data',
    (tester) async {
      final f = VenueFixture()..historical = true;
      final p = await mount(tester, f);
      await tester.tap(find.text('My Space'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Staffing requests'));
      await tester.tap(find.text('Staffing requests'));
      await tester.pumpAndSettle();
      expect(find.byType(VenueOffersScreen), findsOneWidget);
      expect(find.text('Sent Shifts'), findsOneWidget);
      expect(find.byType(MovingTabBar), findsNothing);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('History'));
      await tester.pumpAndSettle();
      // Phase C1: an outage keeps the rows on screen with a non-blocking
      // notice instead of an error page.
      f.fail = true;
      await p.refresh();
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('report-event-card-shift-0')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('stale-refresh-notice')), findsOneWidget);
      expect(find.text('Unable to load'), findsNothing);
      // A revoked permission still drops every row (never kept after a scope
      // change).
      f.denied = true;
      await p.refresh();
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('report-event-card-shift-0')),
        findsNothing,
      );
      expect(find.text('Unable to load'), findsOneWidget);
    },
  );

  test(
    'server user role precedence is restrictive and unknown roles fail closed',
    () {
      CurrentUser user(List<String> roles, {bool admin = false}) =>
          CurrentUser.fromJson({
            ...fakeUserJson(),
            'roles': roles,
            'isPlatformAdmin': admin,
          });
      expect(user(['staff']).presentation, AppPresentation.staff);
      expect(
        user(['staff', 'venue_manager', 'manager']).presentation,
        AppPresentation.venueManager,
      );
      expect(user(['manager']).presentation, AppPresentation.manager);
      expect(user(['ceo']).presentation, AppPresentation.manager);
      expect(user([], admin: true).presentation, AppPresentation.admin);
      expect(user(['admin']).presentation, AppPresentation.unsupported);
    },
  );
  for (final role in ['staff', 'venue_manager', 'manager', 'admin']) {
    testWidgets(
      '$role credentials route from current user and logout clears identity',
      (tester) async {
        stubSecureStorageChannel({
          'rab.applicationTarget': 'venue_manager_app',
        });
        final f = VenueFixture()
          ..role = role
          ..admin = (role == 'admin');
        final auth = AuthProvider(
          apiClient: f.api,
          biometricAuthenticator: FakeBiometricAuthenticator(),
        );
        addTearDown(auth.dispose);
        await tester.pumpWidget(
          ChangeNotifierProvider.value(value: auth, child: const RabApp()),
        );
        await tester.pumpAndSettle();
        await tester.runAsync(
          () => auth.login('qa@example.test', 'Password123!'),
        );
        await auth.completeBiometricSetup(enable: false);
        await tester.pumpAndSettle();
        expect(auth.user!.roles, [role]);
        expect(
          find.byType(
            role == 'staff'
                ? AppShell
                : role == 'venue_manager'
                ? VenueManagerShell
                : ConsoleEntryScreen,
          ),
          findsOneWidget,
        );
        await tester.runAsync(() => auth.logout());
        await auth.completeWelcome();
        await tester.pumpAndSettle();
        expect(auth.user, isNull);
        expect(auth.presentation, AppPresentation.unsupported);
        expect(await auth.api.getAccessToken(), isNull);
        expect(await auth.api.getRefreshToken(), isNull);
        expect(find.text('Application'), findsNothing);
        expect(find.text('Sign In'), findsOneWidget);
      },
    );
    testWidgets('$role session routes without calling other role APIs', (
      tester,
    ) async {
      final f = VenueFixture()
        ..role = role
        ..admin = (role == 'admin');
      final auth = AuthProvider(
        apiClient: f.api,
        biometricAuthenticator: FakeBiometricAuthenticator(),
      );
      await tester.pumpWidget(
        ChangeNotifierProvider.value(value: auth, child: const RabApp()),
      );
      await tester.pumpAndSettle();
      expect(auth.canAccessAuthenticatedUi, isFalse);
      expect(find.byType(AppShell), findsNothing);
      expect(find.byType(VenueManagerShell), findsNothing);
      await auth.login('alice@example.test', 'test-password');
      await auth.completeBiometricSetup(enable: false);
      await tester.pumpAndSettle();
      expect(
        find.byType(
          role == 'staff'
              ? AppShell
              : role == 'venue_manager'
              ? VenueManagerShell
              : ConsoleEntryScreen,
        ),
        findsOneWidget,
      );
      if (role != 'staff') {
        expect(
          f.paths.where(
            (p) => p == '/offers/mine' || p.startsWith('/attendance/me'),
          ),
          isEmpty,
        );
      }
      if (role != 'venue_manager') {
        expect(
          f.paths.where((p) => p == '/shifts' || p == '/staff/venue-directory'),
          isEmpty,
        );
      }
      await tester.pumpWidget(const SizedBox());
      auth.dispose();
    });
  }
  testWidgets(
    'completed events remain in reports but leave the upcoming deck',
    (tester) async {
      final p = await mount(tester, VenueFixture()..completedFirst = true);
      expect(p.events.any((e) => e.shiftId == 'shift-0'), isTrue);
      expect(p.upcoming.any((e) => e.shiftId == 'shift-0'), isFalse);
      expect(p.upcoming, hasLength(3));
    },
  );

  testWidgets('organization, stack and My Space share the approved shell', (
    tester,
  ) async {
    final f = VenueFixture();
    final p = await mount(tester, f);
    expect(find.text('Event Details'), findsOneWidget);
    expect(p.confirmedPeople, 2);
    expect(p.userCount, 3);
    expect(find.byType(VenueEventCard), findsNWidgets(3));
    await shot(tester, '01-organization');
    await tester.drag(
      find.byKey(const ValueKey('upcoming-deck')),
      const Offset(0, -150),
    );
    await tester.pumpAndSettle();
    expect(find.byType(VenueEventCard), findsNWidgets(3));
    await tester.drag(find.byType(ListView).first, const Offset(0, 1000));
    await tester.pumpAndSettle();
    await tester.tap(find.text('My Space'));
    await tester.pumpAndSettle();
    await shot(tester, '02-my-space');
    expect(find.text('Staffing requests'), findsOneWidget);
    expect(find.text('Users'), findsOneWidget);
  });
  testWidgets(
    'system back preserves inactive tab roots and active nested stack',
    (tester) async {
      await mount(tester, VenueFixture());
      await tester.tap(find.text('My Space'));
      await tester.pumpAndSettle();
      for (var attempt = 0; attempt < 3; attempt++) {
        await tester.ensureVisible(find.text('Users'));
        await tester.tap(find.text('Users'));
        await tester.pumpAndSettle();
        expect(find.byType(VenueUsersScreen), findsOneWidget);
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
        expect(find.byType(VenueUsersScreen), findsNothing);
        await tester.ensureVisible(find.text('Reports'));
        await tester.tap(find.text('Reports'));
        await tester.pumpAndSettle();
        expect(find.byType(VenueReportsScreen), findsOneWidget);
        final reportsState = tester.element(find.byType(VenueReportsScreen));
        await tester.tap(find.text('Bartender').first);
        await tester.pumpAndSettle();
        expect(find.byType(ShiftReportScreen), findsOneWidget);
        expect(find.text('Unable to load'), findsNothing);
        expect(find.text('Alice Example'), findsOneWidget);
        expect(find.byType(MovingTabBar), findsNothing);
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
        expect(
          tester.element(find.byType(VenueReportsScreen)),
          same(reportsState),
        );
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
      }
    },
  );

  for (final (name, page) in <(String, Widget)>[
    ('03-users', const VenueUsersScreen()),
    ('05-sent-offers', const VenueOffersScreen()),
    ('06-confirmed-staff', const VenueOffersScreen(confirmedOnly: true)),
    ('07-upcoming-events', const VenueEventsScreen()),
    ('09-reports', const VenueReportsScreen()),
    ('10-calendar', const VenueCalendarScreen()),
  ]) {
    testWidgets('visual $name', (tester) async {
      await mount(tester, VenueFixture()..sendAllowed = true, page: page);
      await shot(tester, name);
    });
  }
  testWidgets('event detail loads the selected scoped record', (tester) async {
    final f = VenueFixture();
    final p = await mount(tester, f);
    await tester.ensureVisible(find.byKey(const ValueKey('upcoming-deck')));
    await tester.tap(find.byTooltip('Open event').hitTestable().last);
    await tester.pumpAndSettle();
    expect(f.paths, contains('/shifts/shift-0'));
    final staffing = find.byKey(const ValueKey('event-staffing-card'));
    expect(
      find.descendant(of: staffing, matching: find.text('20')),
      findsOneWidget,
    );
    expect(find.text('Send offers'), findsNothing);
    await shot(tester, '08-event-detail');
    expect(p.canSend(p.events.first), isFalse);
  });
  testWidgets(
    'search is server scoped and staff acceptance is not confirmation',
    (tester) async {
      final f = VenueFixture();
      await mount(tester, f, page: const VenueUsersScreen());
      await tester.enterText(
        find.byKey(const ValueKey('vm-users-search')),
        'Sam',
      );
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();
      expect(f.directoryQueries.last['q'], 'Sam');
      expect(find.text('Sam Example'), findsOneWidget);
      expect(find.text('Alice Example'), findsNothing);
      expect(offerStatus('staff_accepted'), 'Waiting for Manager Confirmation');
    },
  );
  testWidgets(
    'one Users page lists only assigned directory rows; no All Users, pool or '
    'team calls, and no add/remove controls',
    (tester) async {
      final f = VenueFixture()..sendAllowed = true;
      await mount(tester, f);
      await tester.tap(find.text('My Space'));
      await tester.pumpAndSettle();
      expect(find.text('All Users'), findsNothing);
      await tester.ensureVisible(find.text('Users'));
      await tester.tap(find.text('Users'));
      await tester.pumpAndSettle();
      expect(find.byType(VenueUsersScreen), findsOneWidget);
      for (final id in ['staff-0', 'staff-1', 'staff-2']) {
        expect(find.byKey(ValueKey('vm-users-row-$id')), findsOneWidget);
      }
      // Role subtitle only when the server provided one (Jordan has none).
      expect(find.text('Bartender'), findsNWidgets(2));
      // My Space asks for a real "right now" window, so the badge is real.
      expect(f.directoryQueries.last.containsKey('startAt'), isTrue);
      expect(find.text('Not Available'), findsOneWidget);
      expect(find.text('Available'), findsNWidgets(2));
      for (final forbidden in [
        'All Users',
        'Browse all users',
        'Add staff',
        'Added',
        'NEW',
        'Delete',
        'Remove from team',
      ]) {
        expect(find.text(forbidden), findsNothing);
        expect(find.byTooltip(forbidden), findsNothing);
      }
      expect(find.byIcon(Icons.add), findsNothing);
      expect(f.removedEndpointCalls, isEmpty);
      expect(f.paths.where((p) => p.contains('/pool')), isEmpty);
      expect(f.paths.where((p) => p.contains('/team')), isEmpty);
      expect(f.posted.where((p) => p.contains('venue-directory')), isEmpty);
      await shot(tester, '19-users-assigned-only');
    },
  );
  testWidgets('availability badge is absent when no window was evaluated', (
    tester,
  ) async {
    final user = DirectoryUser.fromJson({
      'id': 'staff-9',
      'firstName': 'No',
      'lastName': 'Window',
      'employmentStatus': 'active',
      'jobRoleName': null,
      'isFavourite': false,
      'isEmergency': false,
    });
    expect(user.available, isNull);
    expect(user.jobRoleName, isNull);
    final f = VenueFixture();
    await mount(
      tester,
      f,
      page: const VenueSelectStaffScreen(initialSelection: {}),
    );
    // Picker opened without a shift window: no window, so no badge.
    expect(f.directoryQueries.last.containsKey('startAt'), isFalse);
    expect(find.text('Available'), findsNothing);
    expect(find.text('Not Available'), findsNothing);
  });
  testWidgets('tag chips filter server-side by tag=favourite / emergency', (
    tester,
  ) async {
    final f = VenueFixture()
      ..favourites.add('staff-1')
      ..emergencies.add('staff-2');
    await mount(tester, f, page: const VenueUsersScreen());
    expect(f.directoryQueries.last.containsKey('tag'), isFalse);
    await tester.tap(find.byKey(const ValueKey('vm-users-chip-favourite')));
    await tester.pumpAndSettle();
    expect(f.directoryQueries.last['tag'], 'favourite');
    expect(find.byKey(const ValueKey('vm-users-row-staff-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('vm-users-row-staff-0')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('vm-users-chip-emergency')));
    await tester.pumpAndSettle();
    expect(f.directoryQueries.last['tag'], 'emergency');
    expect(find.byKey(const ValueKey('vm-users-row-staff-2')), findsOneWidget);
    expect(find.byKey(const ValueKey('vm-users-row-staff-1')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('vm-users-chip-all')));
    await tester.pumpAndSettle();
    expect(f.directoryQueries.last.containsKey('tag'), isFalse);
    expect(find.byKey(const ValueKey('vm-users-row-staff-0')), findsOneWidget);
  });
  testWidgets(
    'empty state only shows after a successful empty load, and explains '
    'that the manager assigns staff',
    (tester) async {
      await mount(
        tester,
        VenueFixture()..staffCount = 0,
        page: const VenueUsersScreen(),
      );
      expect(find.text('No staff assigned to you yet'), findsOneWidget);
      expect(find.text('Your manager assigns staff to you'), findsOneWidget);
      expect(find.byKey(const ValueKey('vm-users-skeleton')), findsNothing);
    },
  );
  testWidgets('a 403 directory response shows a permission message, not 0', (
    tester,
  ) async {
    final f = VenueFixture();
    await mount(tester, f);
    f.status403 = 1;
    Navigator.of(
      tester.element(find.byType(VenueManagerHome)),
    ).push(MaterialPageRoute<void>(builder: (_) => const VenueUsersScreen()));
    await tester.pumpAndSettle();
    expect(
      find.text('You do not have permission to view staff.'),
      findsOneWidget,
    );
    expect(find.text('No staff assigned to you yet'), findsNothing);
    expect(find.text('0'), findsNothing);
  });
  testWidgets(
    'My Space selection persists through search and chips; Send Offer opens '
    'Send Shift preselected and there is no Delete',
    (tester) async {
      final f = VenueFixture()
        ..sendAllowed = true
        ..favourites.add('staff-1');
      await mount(tester, f, page: const VenueUsersScreen());
      expect(find.byKey(const ValueKey('vm-users-send-offer')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('vm-users-select')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('vm-users-done')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('vm-users-row-staff-0')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('vm-users-search')),
        'Sam',
      );
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('vm-users-row-staff-0')), findsNothing);
      await tester.tap(find.byKey(const ValueKey('vm-users-row-staff-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('vm-users-chip-favourite')));
      await tester.pumpAndSettle();
      expect(find.text('2 selected'), findsOneWidget);
      expect(find.text('Delete'), findsNothing);
      expect(find.byIcon(Icons.delete_outline), findsNothing);
      await shot(tester, '20-users-selection');
      await tester.tap(find.byKey(const ValueKey('vm-users-send-offer')));
      await tester.pumpAndSettle();
      expect(find.byType(SendShiftScreen), findsOneWidget);
      expect(find.text('2 selected'), findsOneWidget);
      expect(find.text('Alice Example'), findsOneWidget);
      expect(find.text('Sam Example'), findsOneWidget);
      expect(f.posted, isEmpty);
    },
  );
  testWidgets('a failed favourite change is an error toast, never raw text', (
    tester,
  ) async {
    final f = VenueFixture()
      ..sendAllowed = true
      ..failTags = true;
    await mount(tester, f, page: const VenueUsersScreen());
    final row = find.byKey(const ValueKey('vm-users-row-staff-0'));
    await tester.longPress(row);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add to favourite'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('schedule-toast-error')),
        matching: find.text(
          'Unable to update this staff member. Please try again.',
        ),
      ),
      findsOneWidget,
    );
    expect(find.textContaining('Internal server error'), findsNothing);
    expect(find.byType(SnackBar), findsNothing);
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: row, matching: find.byIcon(Icons.favorite)),
      findsNothing,
    );
  });
  testWidgets(
    'long-press shows quick actions without Delete and favourite PATCHes tags',
    (tester) async {
      final f = VenueFixture()..sendAllowed = true;
      await mount(tester, f, page: const VenueUsersScreen());
      final handle = tester.ensureSemantics();
      final row = find.byKey(const ValueKey('vm-users-row-staff-0'));
      final actions = tester
          .getSemantics(row)
          .getSemanticsData()
          .customSemanticsActionIds;
      expect(actions, hasLength(4));
      handle.dispose();
      await tester.longPress(row);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('vm-quick-actions')), findsOneWidget);
      expect(f.paths, contains('/staff/venue-directory/staff-0'));
      expect(find.text('ALICE EXAMPLE'), findsOneWidget);
      expect(find.text('WORK PROFILE'), findsOneWidget);
      for (final label in [
        'Add to favourite',
        'Add to emergency',
        'Send offer',
        'View profile',
      ]) {
        expect(find.text(label), findsOneWidget);
      }
      expect(find.text('Delete'), findsNothing);
      expect(find.textContaining('Remove from team'), findsNothing);
      // Owner decision: no Notes or Email for Venue Managers, anywhere.
      for (final banned in [
        'Note',
        'Notes',
        'Email',
        'Send email',
        'Add note',
      ]) {
        expect(find.textContaining(banned), findsNothing);
      }
      await shot(tester, '21-quick-actions');
      await tester.tap(find.text('Add to favourite'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('vm-quick-actions')), findsNothing);
      expect(f.tagBodies, [
        {'favourite': true},
      ]);
      expect(
        find.descendant(of: row, matching: find.byIcon(Icons.favorite)),
        findsOneWidget,
      );
      await tester.longPress(row);
      await tester.pumpAndSettle();
      expect(find.text('Remove from favourite'), findsOneWidget);
      // Tapping outside dismisses without acting.
      await tester.tapAt(const Offset(8, 840));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('vm-quick-actions')), findsNothing);
      expect(f.tagBodies, hasLength(1));
    },
  );
  testWidgets(
    'profile renders only provided sections, no review section, and the '
    'heart PATCHes favourite',
    (tester) async {
      final f = VenueFixture()..sendAllowed = true;
      await mount(tester, f, page: const VenueUsersScreen());
      await tester.tap(find.byKey(const ValueKey('vm-users-row-staff-0')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('vm-staff-profile')), findsOneWidget);
      for (final banned in ['Notes', 'Email', 'Add note', 'Send email']) {
        expect(find.textContaining(banned), findsNothing);
      }
      expect(find.text('Staff Profile'), findsOneWidget);
      expect(find.text('ALICE EXAMPLE'), findsOneWidget);
      expect(find.text('WORK PROFILE'), findsOneWidget);
      expect(find.text('Primary role'), findsOneWidget);
      expect(find.text('Full time'), findsOneWidget);
      expect(find.text('Experience'), findsNothing);
      expect(find.text('SKILLS'), findsOneWidget);
      expect(find.text('Cocktails'), findsOneWidget);
      expect(find.text('AVAILABILITY'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('vm-staff-day-Monday-on')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('vm-staff-day-Tuesday-off')),
        findsOneWidget,
      );
      expect(find.text('Preferred shift'), findsNothing);
      expect(find.text('30 hrs/week'), findsOneWidget);
      expect(find.textContaining('Review'), findsNothing);
      expect(find.textContaining('Rating'), findsNothing);
      expect(find.byIcon(Icons.star), findsNothing);
      expect(find.text('Send Offer'), findsOneWidget);
      await shot(tester, '22-staff-profile');
      await tester.tap(
        find.byKey(const ValueKey('vm-staff-profile-favourite')),
      );
      await tester.pumpAndSettle();
      expect(f.paths, contains('/staff/venue-directory/staff-0/tags'));
      expect(f.tagBodies, [
        {'favourite': true},
      ]);
      expect(find.text('Favourited'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('vm-staff-profile-primary')));
      await tester.pumpAndSettle();
      expect(find.byType(SendShiftScreen), findsOneWidget);
      expect(find.text('1 selected'), findsOneWidget);
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      // Back on Users: the row reflects the server-confirmed tag.
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('vm-users-row-staff-0')),
          matching: find.byIcon(Icons.favorite),
        ),
        findsOneWidget,
      );
    },
  );
  testWidgets('a profile with no optional data omits sections, never invents', (
    tester,
  ) async {
    await mount(tester, VenueFixture(), page: const VenueUsersScreen());
    await tester.tap(find.byKey(const ValueKey('vm-users-row-staff-2')));
    await tester.pumpAndSettle();
    expect(find.text('JORDAN EXAMPLE'), findsOneWidget);
    expect(find.text('SKILLS'), findsNothing);
    expect(find.text('Primary role'), findsNothing);
    expect(find.text('Not provided'), findsNWidgets(2));
    expect(find.byKey(const ValueKey('vm-staff-day-Monday-off')), findsNothing);
  });
  testWidgets(
    'a 404 profile says the staff member is no longer assigned and refreshes',
    (tester) async {
      final f = VenueFixture();
      await mount(tester, f, page: const VenueUsersScreen());
      f.unassigned.add('staff-1');
      final before = f.directoryQueries.length;
      await tester.tap(find.byKey(const ValueKey('vm-users-row-staff-1')));
      await tester.pumpAndSettle();
      expect(
        find.text('This staff member is no longer assigned to you'),
        findsOneWidget,
      );
      expect(f.directoryQueries.length, greaterThan(before));
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('vm-users-row-staff-1')), findsNothing);
      expect(
        find.byKey(const ValueKey('vm-users-row-staff-0')),
        findsOneWidget,
      );
    },
  );
  testWidgets(
    'picker profile offers Select Staff, which returns that staff selected',
    (tester) async {
      final f = VenueFixture();
      await mount(
        tester,
        f,
        page: const VenueSelectStaffScreen(initialSelection: {}),
      );
      await tester.longPress(
        find.byKey(const ValueKey('vm-users-row-staff-0')),
      );
      await tester.pumpAndSettle();
      // Inside Send Shift there is no nested "Send offer"; select instead.
      expect(find.text('Send offer'), findsNothing);
      expect(find.text('Select staff'), findsOneWidget);
      await tester.tap(find.text('View profile'));
      await tester.pumpAndSettle();
      expect(find.text('Select Staff'), findsOneWidget);
      expect(find.text('Send Offer'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('vm-staff-profile-primary')));
      await tester.pumpAndSettle();
      expect(find.text('1 selected'), findsOneWidget);
    },
  );
  testWidgets(
    'bulk partial failures keep the existing manager approval workflow',
    (tester) async {
      final f = VenueFixture()..sendAllowed = true;
      final p = await mount(tester, f, page: const VenueUsersScreen());
      final result = await p.send(p.events.first, {'staff-0', 'staff-2'});
      expect(result.where((r) => r['ok'] == true).length, 1);
      expect(result.where((r) => r['ok'] == false).length, 1);
      expect(f.posted, ['/shifts/shift-0/offers/bulk']);
      expect(f.paths.any((p) => p.endsWith('/confirm')), isFalse);
      await tester.pumpAndSettle();
    },
  );
  testWidgets('load errors are distinct from empty data and retry recovers', (
    tester,
  ) async {
    final f = VenueFixture()..fail = true;
    final p = await mount(tester, f);
    // A 503's server text is never shown; the normalised message is.
    expect(find.text('Schedule unavailable'), findsNothing);
    expect(find.text(ApiMessages.serverError), findsOneWidget);
    expect(find.text('Event Details'), findsNothing);
    f.fail = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(p.error, isNull);
    expect(find.text('Event Details'), findsOneWidget);
  });
  for (final size in [
    const Size(320, 640),
    const Size(393, 852),
    const Size(430, 932),
    const Size(375, 812),
  ]) {
    testWidgets('home and calendar fit $size', (tester) async {
      await mount(tester, VenueFixture(), size: size);
      await shot(tester, 'responsive-${size.width.toInt()}');
      await tester.tap(find.byTooltip('Calendar'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'staff selection preserves form, cancel discards edits, final send is single',
    (tester) async {
      final f = VenueFixture()
        ..sendAllowed = true
        ..staffCount = 5;
      await mount(tester, f, page: const SendShiftScreen());
      await tester.tap(find.byKey(const ValueKey('send-venue')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('The Riverside Hotel').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('send-role')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Bartender').last);
      await tester.pumpAndSettle();
      await shot(tester, '11-send-shift');
      await tester.ensureVisible(find.text('Select staff'));
      await tester.tap(find.text('Select staff'));
      await tester.pumpAndSettle();
      // The picker is the one Users page in selection mode: it receives the
      // real shift window and returns the selection on Done.
      expect(f.directoryQueries.last.containsKey('startAt'), isTrue);
      expect(f.directoryQueries.last.containsKey('endAt'), isTrue);
      await tester.tap(find.byKey(const ValueKey('vm-users-row-staff-0')));
      await tester.pumpAndSettle();
      await shot(tester, '12-select-one');
      await tester.tap(find.byKey(const ValueKey('vm-users-done')));
      await tester.pumpAndSettle();
      expect(find.text('1 selected'), findsOneWidget);
      await tester.tap(find.text('Select staff'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('vm-users-row-staff-1')));
      // Back discards the picker's edits.
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(find.text('1 selected'), findsOneWidget);
      await tester.tap(find.text('Select staff'));
      await tester.pumpAndSettle();
      for (var i = 1; i < 5; i++) {
        final row = find.byKey(ValueKey('vm-users-row-staff-$i'));
        await tester.ensureVisible(row);
        await tester.pumpAndSettle();
        await tester.tap(row);
        await tester.pump();
      }
      await tester.pumpAndSettle();
      await shot(tester, '13-select-five');
      expect(find.byKey(const ValueKey('vm-users-send-offer')), findsOneWidget);
      expect(find.text('Delete'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('vm-users-done')));
      await tester.pumpAndSettle();
      expect(find.text('5 selected'), findsOneWidget);
      expect(f.posted, isEmpty);
      await tester.ensureVisible(find.byIcon(Icons.edit_outlined).first);
      await tester.tap(find.byIcon(Icons.edit_outlined).first);
      await tester.pumpAndSettle();
      expect(find.text('Break (minutes) (Optional)'), findsOneWidget);
      await tester.enterText(
        find.byKey(const ValueKey('assignment-break')),
        '60',
      );
      await tester.pumpAndSettle();
      await shot(tester, 'assignment-break-editor');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await shot(tester, '14-form-selection');
      f.sending = Completer<void>();
      await tester.tap(find.text('Send Shift Offer'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      await shot(tester, '15-sending');
      await tester.tap(find.text('Please wait…'));
      await tester.pump();
      expect(f.posted, ['/shifts/request']);
      // "Number of staff required" is no longer independently typed — it is
      // always derived from the real Staff selection (see SendShiftScreen's
      // own doc comment on this deliberate business-model simplification).
      expect(f.sentBody!['staffRequired'], 5);
      expect(f.sentBody!['staffProfileIds'], hasLength(5));
      expect(
        (f.sentBody!['staffAssignments'] as List).first['breakMinutes'],
        60,
      );
      expect(
        (f.sentBody!['staffAssignments'] as List).last['breakMinutes'],
        isNull,
      );
      expect(find.text('Shift submitted successfully'), findsNothing);
      f.sending!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Shift submitted successfully'), findsOneWidget);
      await shot(tester, '16-send-success');
      expect(f.paths.any((p) => p.endsWith('/confirm')), isFalse);
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
    },
  );
  testWidgets('overnight staff cards and editor fit 320px with large text', (
    tester,
  ) async {
    final user = DirectoryUser.fromJson({
      'id': 'staff-0',
      'firstName': 'Alexandra',
      'lastName': 'Example',
      'employmentStatus': 'active',
    });
    final event = VenueEvent(
      {
        'id': 'shift-0',
        'venueId': 'venue-0',
        'jobRoleId': 'role-0',
        'startsAt': DateTime(2026, 10, 14, 21).toIso8601String(),
        'endsAt': DateTime(2026, 10, 15, 5).toIso8601String(),
        'breakMinutes': 30,
      },
      role: 'Bartender',
      venue: 'The Riverside Hotel',
    );
    await mount(
      tester,
      VenueFixture()..sendAllowed = true,
      page: SendShiftScreen(
        initialStaff: {user.id: user},
        existingEvent: event,
      ),
      size: const Size(320, 640),
      scale: 1.8,
    );
    final edit = find.widgetWithIcon(TextButton, Icons.edit_outlined);
    await tester.scrollUntilVisible(
      edit,
      200,
      scrollable: find
          .descendant(
            of: find.byType(SendShiftScreen),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.pumpAndSettle();
    expect(find.text('21:00 - 05:00 (+1 day)'), findsOneWidget);
    await shot(tester, 'assignment-overnight-large-text');
    await tester.tap(edit);
    await tester.pumpAndSettle();
    expect(find.text('Shift time'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('21:00 - 05:00 (+1 day)'), findsOneWidget);
  });

  testWidgets('ambiguous send failure disables unsafe creation retry', (
    tester,
  ) async {
    final f = VenueFixture()
      ..sendAllowed = true
      ..sendFails = true;
    await mount(
      tester,
      f,
      page: SendShiftScreen(
        initialStaff: {
          'staff-0': DirectoryUser.fromJson({
            'id': 'staff-0',
            'firstName': 'Alice',
            'lastName': 'Example',
            'employmentStatus': 'active',
          }),
        },
      ),
    );
    for (final entry in {
      'send-venue': 'The Riverside Hotel',
      'send-role': 'Bartender',
    }.entries) {
      await tester.tap(find.byKey(ValueKey(entry.key)));
      await tester.pumpAndSettle();
      await tester.tap(find.text(entry.value).last);
      await tester.pumpAndSettle();
    }
    await tester.tap(find.text('Send Shift Offer'));
    await tester.pumpAndSettle();
    expect(f.posted, ['/shifts/request']);
    expect(
      tester
          .widget<FilledButton>(
            find.ancestor(
              of: find.text('Send Shift Offer'),
              matching: find.byWidgetPredicate((w) => w is FilledButton),
            ),
          )
          .onPressed,
      isNull,
    );
    await tester.drag(find.byType(ListView).last, const Offset(0, -700));
    await tester.pumpAndSettle();
    expect(find.textContaining('Check Sent Shifts'), findsOneWidget);
    await shot(tester, '18-send-failure');
  });
  testWidgets('empty directory retains search and filter controls, no add', (
    tester,
  ) async {
    await mount(
      tester,
      VenueFixture()..staffCount = 0,
      page: const VenueUsersScreen(),
    );
    expect(find.byKey(const ValueKey('vm-users-search')), findsOneWidget);
    expect(find.byTooltip('Filter users'), findsOneWidget);
    expect(find.byKey(const ValueKey('vm-users-chip-all')), findsOneWidget);
    expect(find.byIcon(Icons.add), findsNothing);
    expect(find.text('All Users'), findsNothing);
    await shot(tester, '17-empty-users');
  });
  for (final size in [
    const Size(320, 640),
    const Size(393, 852),
    const Size(430, 932),
    const Size(375, 812),
  ]) {
    testWidgets('Sent Shifts fits $size and preserves detail/create routes', (
      tester,
    ) async {
      await mount(
        tester,
        VenueFixture(),
        page: const VenueOffersScreen(),
        size: size,
      );
      await shot(tester, 'sent-pastel-${size.width.toInt()}');
      await tester.ensureVisible(find.byTooltip('View sent shift'));
      await tester.tap(find.byTooltip('View sent shift'));
      await tester.pumpAndSettle();
      expect(find.text('Sent shift'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Send Shift'));
      await tester.pumpAndSettle();
      expect(find.byType(SendShiftScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
  for (final scale in [1.0, 1.8]) {
    testWidgets('compact Send Shift at 320px and text scale $scale', (
      tester,
    ) async {
      await mount(
        tester,
        VenueFixture(),
        page: const SendShiftScreen(),
        size: const Size(320, 640),
        scale: scale,
      );
      expect(
        tester
            .widget<FilledButton>(
              find.byWidgetPredicate(
                (widget) => widget is FilledButton && widget.onPressed == null,
              ),
            )
            .onPressed,
        isNull,
      );
      expect(
        find.text('Sending requires offer permission from your Manager.'),
        findsNothing,
      );
      await shot(tester, 'send-compact-$scale');
      expect(find.text('More options'), findsNothing);
      expect(find.byKey(const ValueKey('send-notes')), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
  testWidgets(
    'submitted request remains one card through polled approval and each filter',
    (tester) async {
      final f = VenueFixture();
      final row = {
        ...f.sent.first,
        'status': 'pending_manager_approval',
        'requiredCount': 5,
        'statusLabel': 'Waiting for manager approval',
        'offerCounts': {'sent': 0, 'accepted': 0, 'confirmed': 0},
        'filters': ['pending'],
        'counters': {'sent': false, 'accepted': false, 'confirmed': false},
      };
      f.sentOverride = [row];
      await mount(tester, f, page: const VenueOffersScreen());
      // Real state only: awaiting approval is never shown as sent/accepted.
      expect(find.text('Pending approval'), findsOneWidget);
      expect(find.text('Not sent yet'), findsOneWidget);
      expect(find.text('Sent 2h ago'), findsOneWidget);
      expect(find.text('No sent shifts yet'), findsNothing);
      expect(find.text('0'), findsNWidgets(3));
      await shot(tester, 'sent-request-before-approval');
      final search = find.byType(TextField);
      await tester.enterText(search, 'Riverside');
      f.sentOverride = [
        {
          ...row,
          'status': 'offered',
          'statusLabel': 'Offers sent',
          'offerCounts': {
            'sent': 5,
            'pending': 5,
            'accepted': 0,
            'confirmed': 0,
          },
          'counters': {'sent': true, 'accepted': false, 'confirmed': false},
        },
      ];
      await tester.pump(sentPollGap);
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('sent-shift-card-shift-0')),
          matching: find.text('Pending'),
        ),
        findsOneWidget,
      );
      expect(find.text('Pending approval'), findsNothing);
      expect(find.text('Sent to 5 staff'), findsOneWidget);
      expect(find.byTooltip('View sent shift'), findsOneWidget);
      expect(
        tester.widget<EditableText>(find.byType(EditableText)).controller.text,
        'Riverside',
      );
      await shot(tester, 'sent-request-after-approval');
      f.sentOverride = [
        {
          ...row,
          'status': 'fully_filled',
          'statusLabel': 'Confirmed',
          'offerCounts': {'sent': 5, 'accepted': 0, 'confirmed': 5},
          'filters': ['staff_accepted', 'manager_confirmed'],
          'counters': {'sent': true, 'accepted': true, 'confirmed': true},
        },
      ];
      await tester.pump(sentPollGap);
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('sent-shift-card-shift-0')),
          matching: find.text('Confirmed'),
        ),
        findsOneWidget,
      );
      await shot(tester, 'sent-request-confirmed');
      f.sentOverride = [
        {
          ...row,
          'status': 'partially_filled',
          'statusLabel': 'Staff responses received',
          'offerCounts': {
            'sent': 5,
            'accepted': 0,
            'confirmed': 4,
            'declined': 1,
          },
          'filters': ['staff_accepted', 'declined'],
          'counters': {'sent': true, 'accepted': true, 'confirmed': false},
        },
      ];
      await tester.pump(sentPollGap);
      await tester.pumpAndSettle();
      // Accepted but not every seat confirmed: never conflated.
      final card = find.byKey(const ValueKey('sent-shift-card-shift-0'));
      expect(
        find.descendant(of: card, matching: find.text('Accepted')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: card, matching: find.text('Confirmed')),
        findsNothing,
      );
      await shot(tester, 'sent-request-declined');

      for (final entry in {
        'pending': 'pending',
        'accepted': 'staff_accepted',
        'confirmed': 'manager_confirmed',
        'declined': 'declined',
      }.entries) {
        f.sentOverride = [
          {
            ...row,
            'statusLabel': 'Test server response',
            'filters': [entry.value],
          },
        ];
        await tester.pump(sentPollGap);
        await tester.pumpAndSettle();
        final chip = find.byKey(Key('sent-view-${entry.key}'));
        await tester.ensureVisible(chip);
        await tester.tap(chip);
        await tester.pumpAndSettle();
        expect(find.byTooltip('View sent shift'), findsOneWidget);
      }
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'resume after the background runs ONE full refresh; a notification '
    'shade (inactive only) does not',
    (tester) async {
      final f = VenueFixture();
      await mount(tester, f);
      int fullRefreshes() =>
          f.paths.where((p) => p == '/auth/capabilities').length;
      final before = fullRefreshes();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(fullRefreshes(), before);
      for (final state in [
        AppLifecycleState.inactive,
        AppLifecycleState.hidden,
        AppLifecycleState.paused,
        AppLifecycleState.hidden,
        AppLifecycleState.inactive,
        AppLifecycleState.resumed,
      ]) {
        tester.binding.handleAppLifecycleStateChanged(state);
      }
      await tester.pumpAndSettle();
      expect(fullRefreshes(), before + 1);
      await tester.pumpWidget(const SizedBox());
    },
  );

  List<Map<String, dynamic>> sentRequests(
    VenueFixture f, {
    int active = 3,
    int expired = 0,
  }) => [
    for (var i = 0; i < active + expired; i++)
      {
        ...f.shifts.first,
        'id': 'request-$i',
        'roleName': 'Bartender',
        'venueName': 'The Riverside Hotel',
        'submittedAt': DateTime.now()
            .subtract(Duration(hours: 2 + i))
            .toIso8601String(),
        'requiredCount': 4,
        // Four recipients per request: 3 requests = 12 recipient-level offers.
        'offerCounts': {
          'sent': 4,
          'pending': i < active ? 4 : 0,
          'accepted': 0,
          'confirmed': 0,
          'expired': i < active ? 0 : 4,
        },
        'statusLabel': i < active ? 'Offers sent' : 'Expired',
        'actionExpired': i >= active,
        'filters': i < active ? ['pending'] : ['expired'],
        'counters': {'sent': true, 'accepted': false, 'confirmed': false},
      },
  ];

  testWidgets(
    'My Space "Staffing requests" counts distinct submitted requests (3), never recipient offers (12)',
    (tester) async {
      final f = VenueFixture();
      f.sentOverride = sentRequests(f);
      final p = await mount(tester, f);
      await tester.tap(find.text('My Space'));
      await tester.pumpAndSettle();
      expect(p.sentSubmitted, 3);
      final tile = find.ancestor(
        of: find.text('Staffing requests'),
        matching: find.byType(ListTile),
      );
      expect(
        find.descendant(of: tile, matching: find.text('3')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: tile, matching: find.text('12')),
        findsNothing,
      );
      await shot(tester, 'my-space-sent-offers-3');
    },
  );

  testWidgets(
    'Sent Shifts: All excludes expired requests; Expired shows only them, read-only',
    (tester) async {
      final f = VenueFixture();
      f.sentOverride = sentRequests(f, active: 3, expired: 2);
      await mount(tester, f, page: const VenueOffersScreen());
      // All: the three live requests only.
      for (var i = 0; i < 3; i++) {
        expect(
          find.byKey(ValueKey('sent-shift-card-request-$i')),
          findsOneWidget,
        );
      }
      expect(
        find.byKey(const ValueKey('sent-shift-card-request-3')),
        findsNothing,
      );
      expect(find.text('Expired'), findsNothing);
      expect(find.text('All 3'), findsOneWidget);
      await shot(tester, 'sent-shifts-all-excludes-expired');

      final chip = find.byKey(const Key('sent-view-expired'));
      await tester.scrollUntilVisible(
        chip,
        80,
        scrollable: find
            .ancestor(
              of: find.byKey(const Key('sent-view-all')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(find.text('Expired 2'), findsOneWidget);
      await tester.ensureVisible(chip);
      await tester.pumpAndSettle();
      await tester.tap(chip);
      await tester.pumpAndSettle();
      expect(find.text('No expired shifts.'), findsNothing);
      expect(
        find.byKey(const ValueKey('sent-shift-card-request-3')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('sent-shift-card-request-4')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('sent-shift-card-request-0')),
        findsNothing,
      );
      // The server classified the view: the phone asked for it, it did not filter locally.
      expect(
        f.paths.where((path) => path == '/shifts/sent').length,
        greaterThan(1),
      );
      await shot(tester, 'sent-shifts-expired-tab');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('sent cards do not display a UUID as the role', (tester) async {
    final fixture = VenueFixture()
      ..offerRole = 'Role-31e32d66-4454-41f5-a026-b81e62c258de';
    await mount(tester, fixture, page: const VenueOffersScreen());
    expect(find.text(fixture.offerRole), findsNothing);
    expect(find.text('Role unavailable'), findsOneWidget);
  });
  testWidgets('large text remains scrollable', (tester) async {
    await mount(tester, VenueFixture(), size: const Size(320, 640), scale: 1.8);
    await shot(tester, 'large-text');
  });
}
