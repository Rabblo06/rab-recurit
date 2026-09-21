import 'dart:convert';
import 'dart:async';
import 'package:rab_staff/features/venue_manager/send_shift_screen.dart';
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
import 'package:rab_staff/features/venue_manager/venue_manager_screens.dart';
import 'package:rab_staff/navigation/app_shell.dart';
import 'package:rab_staff/navigation/console_entry_screen.dart';
import 'support/biometric_test_support.dart';

class VenueFixture {
  String role = 'venue_manager';
  String offerRole = 'Bartender';
  bool admin = false, fail = false, sendAllowed = false;
  final paths = <String>[];
  final posted = <String>[];
  final memberships = <String>{};
  int staffCount = 3;
  int allUsersCount = 3;
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
          .add(Duration(days: i, hours: 1))
          .toIso8601String(),
      'endsAt': DateTime.now()
          .add(Duration(days: i, hours: 8))
          .toIso8601String(),
      'requiredCount': 20,
      'filledCount': i + 3,
      'status': 'partially_filled',
      'address': '12 High Street, Bristol, BS1 2AB',
      'notes': 'Please use the staff entrance. Bring your staff ID.',
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
        body = {
          'schedule.view': true,
          'venue.view': true,
          'staff.view': true,
          'report.view': true,
          'offer.send': sendAllowed,
          'staffing_request.create': sendAllowed,
        };
      } else if (path == '/shifts') {
        if (fail) {
          return http.Response('{"message":"Schedule unavailable"}', 503);
        }
        body = {'data': shifts, 'total': 4};
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
        final query = r.url.queryParameters['q'] ?? '';
        final rows = [
          for (var i = 0; i < staffCount; i++)
            {
              'id': 'staff-$i',
              'firstName': ['Alice', 'Sam', 'Jordan', 'Taylor', 'Morgan'][i],
              'lastName': 'Example',
              'employmentStatus': 'active',
            },
        ];
        for (final id in memberships) {
          final i = int.parse(id.split('-').last);
          rows.add({
            'id': id,
            'firstName': ['Alice', 'Sam', 'Jordan', 'Taylor', 'Morgan'][i],
            'lastName': 'Example',
            'employmentStatus': 'active',
          });
        }
        final filtered = rows
            .where(
              (u) =>
                  u['firstName']!.toLowerCase().contains(query.toLowerCase()),
            )
            .toList();
        body = {'data': filtered, 'total': filtered.length};
      } else if (path == '/staff/venue-directory/pool') {
        // The broader "All Users" pool — same staff, plus the fields
        // venue-directory doesn't return. `pool-0` (Alice) was created
        // yesterday (NEW); everyone else, 30 days ago (not NEW).
        final query = r.url.queryParameters['q'] ?? '';
        final rows = [
          for (var i = 0; i < allUsersCount; i++)
            {
              'id': 'pool-$i',
              'added': memberships.contains('pool-$i'),
              'firstName': ['Alice', 'Sam', 'Jordan', 'Taylor', 'Morgan'][i],
              'lastName': 'Example',
              'email': 'pool-$i@example.test',
              'staffRef': 'REF-$i',
              'employmentStatus': 'active',
              'createdAt': DateTime.now()
                  .subtract(Duration(days: i == 0 ? 1 : 30))
                  .toIso8601String(),
            },
        ];
        final q = query.toLowerCase();
        final filtered = rows
            .where(
              (u) =>
                  (u['firstName'] as String).toLowerCase().contains(q) ||
                  (u['email'] as String).toLowerCase().contains(q) ||
                  (u['staffRef'] as String).toLowerCase().contains(q),
            )
            .toList();
        body = {'data': filtered, 'total': filtered.length};
      } else if (path.startsWith('/staff/venue-directory/team/')) {
        posted.add(path);
        memberships.add(path.split('/').last);
        body = {'added': true};
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
        expect(find.text('Log in'), findsOneWidget);
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
    expect(find.text('Sent offers'), findsOneWidget);
    expect(find.text('Users'), findsOneWidget);
  });
  for (final (name, page) in <(String, Widget)>[
    ('03-users', const VenueUsersScreen()),
    ('04-all-users', const VenueAllUsersScreen()),
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
    expect(find.text('Required: 20'), findsOneWidget);
    expect(find.text('Send offers'), findsNothing);
    await shot(tester, '08-event-detail');
    expect(p.canSend(p.events.first), isFalse);
  });
  testWidgets(
    'search is server scoped and staff acceptance is not confirmation',
    (tester) async {
      final f = VenueFixture();
      await mount(tester, f, page: const VenueUsersScreen());
      await tester.enterText(find.byType(TextField), 'Sam');
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();
      expect(find.text('Sam Example'), findsOneWidget);
      expect(find.text('Alice Example'), findsNothing);
      expect(offerStatus('staff_accepted'), 'Waiting for Manager Confirmation');
    },
  );
  testWidgets(
    'All Users shows a just-created Staff member with a NEW badge, an '
    '8-day-old one without, and search still finds the new member by name',
    (tester) async {
      final f = VenueFixture()..allUsersCount = 3;
      await mount(tester, f, page: const VenueAllUsersScreen());
      // '/staff/venue-directory' is still hit once by refresh()'s own
      // Home-screen user-count stat (unrelated to this screen) — only the
      // *repeated* All Users load must use the broader pool endpoint.
      expect(f.paths, contains('/staff/venue-directory/pool'));
      expect(f.paths.where((p) => p == '/staff/venue-directory'), hasLength(1));
      // Alice (pool-0, created 1 day ago) carries the badge; Sam (30 days
      // ago) does not — one shared isNewUser() rule, not per-widget logic.
      expect(find.text('NEW'), findsOneWidget);
      final aliceTile = find.ancestor(
        of: find.text('Alice Example'),
        matching: find.byType(ListTile),
      );
      final samTile = find.ancestor(
        of: find.text('Sam Example'),
        matching: find.byType(ListTile),
      );
      expect(
        find.descendant(of: aliceTile, matching: find.text('NEW')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: samTile, matching: find.text('NEW')),
        findsNothing,
      );
      await shot(tester, '19-all-users-new-badge');

      await tester.enterText(find.byType(TextField), 'Alice');
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();
      expect(find.text('Alice Example'), findsOneWidget);
      expect(find.text('NEW'), findsOneWidget);
      expect(find.text('Sam Example'), findsNothing);
    },
  );
  testWidgets(
    'Users plus adds membership, returns to team, and selector excludes unadded pool',
    (tester) async {
      final f = VenueFixture()
        ..staffCount = 0
        ..allUsersCount = 3;
      await mount(tester, f, page: const VenueUsersScreen());
      expect(find.text('No staff added yet.'), findsOneWidget);
      await tester.tap(find.byTooltip('All Users'));
      await tester.pumpAndSettle();
      expect(find.text('All Users'), findsOneWidget);
      expect(find.byType(SendShiftScreen), findsNothing);
      await tester.tap(find.byTooltip('Add staff').first);
      await tester.pumpAndSettle();
      expect(f.memberships, {'pool-0'});
      expect(f.posted, ['/staff/venue-directory/team/pool-0']);
      expect(find.byTooltip('Added'), findsOneWidget);
      await shot(tester, 'team-added');
      await tester.tap(find.byTooltip('Back').last);
      await tester.pumpAndSettle();
      expect(find.text('Alice Example'), findsOneWidget);
      expect(find.text('Sam Example'), findsNothing);
      await shot(tester, 'team-users');
      Navigator.of(tester.element(find.byType(VenueUsersScreen))).push(
        MaterialPageRoute<void>(
          builder: (_) => const VenueSelectStaffScreen(initialSelection: {}),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Alice Example'), findsOneWidget);
      expect(find.text('Sam Example'), findsNothing);
      expect(find.byTooltip('Browse all users'), findsNothing);
      await shot(tester, 'team-selector');
    },
  );
  testWidgets(
    'All Users empty state only shows after a successful empty load',
    (tester) async {
      await mount(
        tester,
        VenueFixture()..allUsersCount = 0,
        page: const VenueAllUsersScreen(),
      );
      expect(find.text('No active staff available.'), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsNothing);
    },
  );
  testWidgets(
    'bulk partial failures keep the existing manager approval workflow',
    (tester) async {
      final f = VenueFixture()..sendAllowed = true;
      final p = await mount(tester, f, page: const VenueAllUsersScreen());
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
    expect(find.text('Schedule unavailable'), findsOneWidget);
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
      await tester.tap(find.byType(Checkbox).first);
      await tester.pumpAndSettle();
      await shot(tester, '12-select-one');
      await tester.tap(find.text('Submit'));
      await tester.pumpAndSettle();
      expect(find.text('1 selected'), findsOneWidget);
      await tester.tap(find.text('Select staff'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Checkbox).at(1));
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(find.text('1 selected'), findsOneWidget);
      await tester.tap(find.text('Select staff'));
      await tester.pumpAndSettle();
      for (var i = 1; i < 5; i++) {
        await tester.tap(find.byType(Checkbox).at(i));
        await tester.pump();
      }
      await tester.pumpAndSettle();
      await shot(tester, '13-select-five');
      await tester.tap(find.text('Submit'));
      await tester.pumpAndSettle();
      expect(find.text('5 selected'), findsOneWidget);
      expect(f.posted, isEmpty);
      await shot(tester, '14-form-selection');
      f.sending = Completer<void>();
      await tester.tap(find.text('Send Shift Offer'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      await shot(tester, '15-sending');
      await tester.tap(find.textContaining('Sending'));
      await tester.pump();
      expect(f.posted, ['/shifts/request']);
      // "Number of staff required" is no longer independently typed — it is
      // always derived from the real Staff selection (see SendShiftScreen's
      // own doc comment on this deliberate business-model simplification).
      expect(f.sentBody!['staffRequired'], 5);
      expect(f.sentBody!['staffProfileIds'], hasLength(5));
      f.sending!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Shift request submitted'), findsOneWidget);
      await shot(tester, '16-send-success');
      expect(f.paths.any((p) => p.endsWith('/confirm')), isFalse);
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
    },
  );
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
  testWidgets('empty directory retains add, search and filter controls', (
    tester,
  ) async {
    await mount(
      tester,
      VenueFixture()
        ..staffCount = 0
        ..allUsersCount = 0,
      page: const VenueUsersScreen(),
    );
    expect(find.byType(TextField), findsOneWidget);
    expect(find.byIcon(Icons.add), findsOneWidget);
    await shot(tester, '17-empty-users');
    await tester.tap(find.byIcon(Icons.add));
    await tester.pumpAndSettle();
    expect(find.text('All Users'), findsOneWidget);
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
      expect(find.text('Sent Shift'), findsOneWidget);
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
      await tester.scrollUntilVisible(
        find.text('More options'),
        150,
        scrollable: find
            .descendant(
              of: find.byType(SendShiftScreen),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.tap(find.text('More options'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const ValueKey('send-notes')));
      await tester.enterText(
        find.byKey(const ValueKey('send-notes')),
        'Keep the staff entrance clear',
      );
      expect(tester.takeException(), isNull);
    });
  }
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
