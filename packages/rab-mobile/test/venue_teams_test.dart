import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/theme/shift_visual_style.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/shift_countdown_panel.dart';
import 'package:rab_staff/features/venue_manager/shift_report.dart';
import 'package:rab_staff/features/venue_manager/staff_qr_screen.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_screens.dart';
import 'package:rab_staff/features/venue_manager/venue_teams_screen.dart';

import 'support/biometric_test_support.dart';

/// Venue Manager Teams (Event Details → Clock-In/Out), on-behalf punches and
/// the Staff Qr-Code screen, against server-shaped responses.
///
/// Screenshots: `--dart-define=CHECKIN_CAPTURE_DIR=DIR`.
const _captureDir = String.fromEnvironment('CHECKIN_CAPTURE_DIR');

String _iso(DateTime d) => d.toUtc().toIso8601String();

const _tenWords =
    'Phone battery died at the door so I am clocking her in.';

class TeamsFixture {
  TeamsFixture({this.geofence = false, DateTime? serverNow}) {
    final today = DateTime.now();
    start = DateTime(today.year, today.month, today.day, 20, 45);
    end = start.add(const Duration(hours: 3));
    now = serverNow ?? start.subtract(const Duration(minutes: 20, seconds: -3));
    seats = [
      seat('staff-lucy', 'Lucy Example'),
      seat(
        'staff-alex',
        'Alex Example',
        checkedInAt: start.subtract(const Duration(minutes: 6)),
      ),
      seat(
        'staff-jen',
        'Jeniffer Example',
        checkedInAt: start.subtract(const Duration(minutes: 9)),
        attendanceId: 'att-jen',
        status: 'clocked_in',
        inAt: start.subtract(const Duration(minutes: 2)),
      ),
      seat(
        'staff-love',
        'Love Example',
        checkedInAt: start.subtract(const Duration(minutes: 12)),
        attendanceId: 'att-love',
        status: 'clocked_out',
        inAt: start,
        outAt: start.add(const Duration(minutes: 30)),
      ),
    ];
  }

  final bool geofence;
  late DateTime start, end, now;
  late List<Map<String, dynamic>> seats;
  Map<String, dynamic> capabilities = {
    'report.view': true,
    'attendance.edit': true,
  };
  final posts = <String, Map<String, dynamic>>{};
  // Phase C1 polling: every report read's background header, and an outage.
  final reportReads = <String?>[];
  bool failReport = false;
  int reportFailStatus = 503;
  String? clockOutError;
  Map<String, dynamic> actions = {};
  Map<String, dynamic> qrWindow = {};
  List<int> pdf = utf8.encode('%PDF-1.4 shift sheet');
  int downloads = 0;

  Map<String, dynamic> seat(
    String id,
    String name, {
    DateTime? checkedInAt,
    String? attendanceId,
    String? status,
    DateTime? inAt,
    DateTime? outAt,
    bool verified = true,
  }) => {
    'staffProfileId': id,
    'staffName': name,
    'roleName': 'Bartender',
    'scheduledStart': _iso(start),
    'scheduledEnd': _iso(end),
    'assignmentStatus': 'confirmed',
    'attendanceId': attendanceId,
    'attendanceStatus': status,
    'clockInAt': inAt == null ? null : _iso(inAt),
    'clockOutAt': outAt == null ? null : _iso(outAt),
    'breakMinutes': null,
    'scheduledBreakMinutes': 0,
    'workedMinutes': null,
    'earnedPence': null,
    'attendanceReviewed': false,
    'checkInRequired': true,
    'checkedInAt': checkedInAt == null ? null : _iso(checkedInAt),
    'checkInSource': checkedInAt == null ? null : 'staff',
    'checkInLocationVerified': checkedInAt != null && verified,
    'clockInMethod': inAt == null ? null : 'staff',
  };

  Map<String, dynamic> report() => {
    'shiftId': 'shift-1',
    'venueName': 'Venue Test 1',
    'roleName': 'Test Role 1',
    'startsAt': _iso(start),
    'endsAt': _iso(end),
    'reportStatus': 'pending',
    'staff': seats,
    'serverNow': _iso(now),
    'attendancePolicy': {
      'geofenceEnforced': geofence,
      'onBehalfClockOutAllowed': !geofence,
      'onBehalfReasonMinWords': 10,
    },
    if (actions.isNotEmpty) 'actions': actions,
    if (qrWindow.isNotEmpty) 'qrWindow': qrWindow,
  };

  Map<String, dynamic> get event => {
    'id': 'shift-1',
    'createdBy': 'user-1',
    'venueId': 'venue-1',
    'jobRoleId': 'role-1',
    'startsAt': start.toIso8601String(),
    'endsAt': end.toIso8601String(),
    'requiredCount': 4,
    'filledCount': 4,
    'status': 'fully_filled',
    'address': '',
    'notes': '',
  };

  late final api = ApiClient(
    httpClient: MockClient((r) async {
      final path = r.url.path.replaceFirst('/rest/v1', '');
      if (path == '/attendance/report/shift/shift-1') {
        reportReads.add(r.headers['X-Crewflow-Background']);
        if (failReport) {
          return http.Response('{"message":"Unavailable"}', reportFailStatus);
        }
        return http.Response(jsonEncode(report()), 200);
      }
      final onBehalf = RegExp(
        r'^/attendance/report/shift/shift-1/staff/([^/]+)/(clock-in|clock-out)-on-behalf$',
      ).firstMatch(path);
      if (onBehalf != null && r.method == 'POST') {
        final staff = onBehalf.group(1)!;
        final kind = onBehalf.group(2)!;
        posts['$kind:$staff'] = jsonDecode(r.body) as Map<String, dynamic>;
        if (kind == 'clock-out' && clockOutError != null) {
          return http.Response(
            jsonEncode({
              'statusCode': 409,
              'code': clockOutError,
              'message': 'x',
            }),
            409,
          );
        }
        final i = seats.indexWhere((s) => s['staffProfileId'] == staff);
        seats[i] = kind == 'clock-in'
            ? {
                ...seats[i],
                'attendanceId': 'att-$staff',
                'attendanceStatus': 'clocked_in',
                'clockInAt': _iso(now),
                'clockInMethod': 'manager_on_behalf',
                'clockInByName': 'Issac Nepolean',
              }
            : {
                ...seats[i],
                'attendanceStatus': 'clocked_out',
                'clockOutAt': _iso(now),
              };
        return http.Response(jsonEncode(report()), 200);
      }
      if (path == '/shifts/shift-1') {
        return http.Response(jsonEncode(event), 200);
      }
      if (path == '/files/sheet-1/download') {
        downloads++;
        return http.Response.bytes(
          pdf,
          200,
          headers: {'content-type': 'application/pdf'},
        );
      }
      return http.Response('[]', 200);
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

  Future<VenueManagerProvider> mount(
    WidgetTester tester,
    TeamsFixture f,
    Widget Function(VenueEvent e) page, {
    Size size = const Size(393, 852),
    double scale = 1,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final p = VenueManagerProvider(f.api, 'user-1')
      ..capabilities = f.capabilities;
    addTearDown(p.dispose);
    final event = VenueEvent(f.event, role: 'Test Role 1', venue: 'Venue Test 1');
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: p,
        child: MaterialApp(
          theme: buildLightTheme().copyWith(
            textTheme: buildLightTheme().textTheme.apply(fontFamily: 'Roboto'),
          ),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
              padding: const EdgeInsets.only(top: 24, bottom: 24),
            ),
            child: RepaintBoundary(key: boundary, child: child),
          ),
          home: page(event),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return p;
  }

  Widget teams(VenueEvent e) =>
      VenueTeamsScreen(event: e, leaderName: 'Issac Nepolean');

  Future<void> capture(WidgetTester tester, String name) async {
    expect(tester.takeException(), isNull);
    if (_captureDir.isEmpty) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(_captureDir).create(recursive: true);
      await File(
        '$_captureDir/$name.png',
      ).writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  Finder action(String id) => find.byKey(ValueKey('team-action-$id'));
  Finder chip(String id) => find.byKey(ValueKey('team-chip-$id'));
  String chipText(WidgetTester tester, String id) => tester
      .widget<Text>(find.descendant(of: chip(id), matching: find.byType(Text)))
      .data!;
  String hm(DateTime d) =>
      '${d.toLocal().hour.toString().padLeft(2, '0')}:${d.toLocal().minute.toString().padLeft(2, '0')}';

  testWidgets('Teams: leader, rows, state chips and per-row actions', (
    tester,
  ) async {
    final f = TeamsFixture();
    await mount(tester, f, teams);
    expect(find.text('Teams'), findsOneWidget);
    expect(find.text('Venue Test 1'), findsOneWidget);
    expect(find.text('Team Leader'), findsOneWidget);
    expect(find.text('Issac Nepolean'), findsOneWidget);
    expect(find.text('You'), findsOneWidget);
    expect(find.text('Your team'), findsOneWidget);
    expect(find.text('4 people'), findsOneWidget);
    expect(chipText(tester, 'staff-lucy'), 'Not checked in');
    expect(
      chipText(tester, 'staff-alex'),
      'Checked in ${hm(f.start.subtract(const Duration(minutes: 6)))}',
    );
    expect(
      chipText(tester, 'staff-jen'),
      'Clocked in ${hm(f.start.subtract(const Duration(minutes: 2)))}',
    );
    expect(
      chipText(tester, 'staff-love'),
      'Clocked out ${hm(f.start.add(const Duration(minutes: 30)))}',
    );
    expect(find.descendant(of: action('staff-lucy'), matching: find.text('Clock-In')), findsOneWidget);
    expect(find.descendant(of: action('staff-alex'), matching: find.text('Clock-In')), findsOneWidget);
    expect(find.descendant(of: action('staff-jen'), matching: find.text('Clock-out')), findsOneWidget);
    expect(action('staff-love'), findsNothing);
    await capture(tester, 'vm-teams-before-start');
  });

  testWidgets('countdown: red "starts in" before, green elapsed after start', (
    tester,
  ) async {
    final f = TeamsFixture();
    await mount(tester, f, teams);
    var panel = tester.widget<ShiftCountdownPanel>(
      find.byType(ShiftCountdownPanel),
    );
    expect(panel.heading, 'Your shift starts in');
    expect(panel.warning, isTrue);
    expect(find.text('19'), findsOneWidget); // 00:19:57 to the start
    expect(find.textContaining('started in'), findsNothing);

    final later = TeamsFixture(
      serverNow: DateTime.now().copyWith(hour: 21, minute: 25, second: 3),
    );
    await tester.pumpWidget(const SizedBox());
    await mount(tester, later, teams);
    panel = tester.widget<ShiftCountdownPanel>(find.byType(ShiftCountdownPanel));
    expect(panel.heading, 'Shift in progress');
    expect(panel.warning, isFalse);
    expect(find.text('40'), findsOneWidget);
    await capture(tester, 'vm-teams-in-progress');
  });

  testWidgets('Clock-In before the staff check-in: blocked sheet, no request', (
    tester,
  ) async {
    final f = TeamsFixture();
    await mount(tester, f, teams);
    await tester.tap(action('staff-lucy'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('team-blocked-sheet')), findsOneWidget);
    expect(find.text('Clock in Lucy?'), findsOneWidget);
    expect(find.text('Clock in on behalf of this team member.'), findsOneWidget);
    expect(find.text("Staff hasn't checked in yet"), findsOneWidget);
    expect(
      find.text('Lucy must check in before you can clock them in.'),
      findsOneWidget,
    );
    await capture(tester, 'vm-teams-blocked');
    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    expect(f.posts, isEmpty);
  });

  testWidgets('geofence venue: an unverified check-in is blocked too', (
    tester,
  ) async {
    final f = TeamsFixture(geofence: true);
    f.seats[1] = f.seat(
      'staff-alex',
      'Alex Example',
      checkedInAt: f.start.subtract(const Duration(minutes: 6)),
      verified: false,
    );
    await mount(tester, f, teams);
    await tester.tap(action('staff-alex'));
    await tester.pumpAndSettle();
    expect(find.text('Check-in not location-verified'), findsOneWidget);
    expect(f.posts, isEmpty);
  });

  testWidgets(
    'reason sheet: < 10 words keeps Confirm disabled; a valid reason posts and the row updates',
    (tester) async {
      final f = TeamsFixture();
      await mount(tester, f, teams);
      await tester.tap(action('staff-alex'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('team-reason-sheet')), findsOneWidget);
      expect(find.text('Clock in Alex?'), findsOneWidget);
      expect(find.text('Reason*'), findsOneWidget);
      expect(
        find.text('Add a 10 words reason for this manual clock-in…'),
        findsOneWidget,
      );
      expect(find.text('Venue Test 1 · ${hm(f.start)}–${hm(f.end)}'), findsOneWidget);
      await capture(tester, 'vm-teams-reason');
      final confirm = find.byKey(const ValueKey('team-reason-confirm'));
      FilledButton button() => tester.widget<FilledButton>(
        find.descendant(of: confirm, matching: find.byType(FilledButton)),
      );
      expect(button().onPressed, isNull);
      await tester.enterText(
        find.byKey(const ValueKey('team-reason-field')),
        'Phone died at the door',
      );
      await tester.pump();
      expect(button().onPressed, isNull);
      expect(find.textContaining('5 of 10 words'), findsOneWidget);
      // Punctuation-only "words" do not count, as on the server.
      await tester.enterText(
        find.byKey(const ValueKey('team-reason-field')),
        'one two three four five six seven eight nine - - -',
      );
      await tester.pump();
      expect(button().onPressed, isNull);
      await tester.tap(confirm, warnIfMissed: false);
      await tester.pump();
      expect(f.posts, isEmpty);

      await tester.enterText(
        find.byKey(const ValueKey('team-reason-field')),
        _tenWords,
      );
      await tester.pump();
      expect(button().onPressed, isNotNull);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(f.posts.keys, ['clock-in:staff-alex']);
      expect(f.posts['clock-in:staff-alex'], {'reason': _tenWords});
      expect(find.byKey(const ValueKey('team-reason-sheet')), findsNothing);
      expect(chipText(tester, 'staff-alex'), 'Clocked in ${hm(f.now)}');
      expect(find.text('Clocked in by Issac Nepolean'), findsOneWidget);
      expect(
        find.descendant(of: action('staff-alex'), matching: find.text('Clock-out')),
        findsOneWidget,
      );
      // No success toast: the row is the confirmation.
      expect(find.textContaining('success'), findsNothing);
      await capture(tester, 'vm-teams-after-clock-in');
    },
  );

  testWidgets('Clock-out: reason sheet posts clock-out-on-behalf', (
    tester,
  ) async {
    final f = TeamsFixture();
    await mount(tester, f, teams);
    await tester.tap(action('staff-jen'));
    await tester.pumpAndSettle();
    expect(find.text('Clock out Jeniffer?'), findsOneWidget);
    expect(
      find.text('Add a 10 words reason for this manual clock-out…'),
      findsOneWidget,
    );
    await tester.enterText(
      find.byKey(const ValueKey('team-reason-field')),
      _tenWords,
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('team-reason-confirm')));
    await tester.pumpAndSettle();
    expect(f.posts.keys, ['clock-out:staff-jen']);
    expect(chipText(tester, 'staff-jen'), 'Clocked out ${hm(f.now)}');
    expect(action('staff-jen'), findsNothing);
  });

  testWidgets(
    'Clock-out at a geofence venue: explained, no request, points to Record attendance',
    (tester) async {
      final f = TeamsFixture(geofence: true);
      await mount(tester, f, teams);
      await tester.tap(action('staff-jen'));
      await tester.pumpAndSettle();
      expect(find.text("Clock-out on behalf isn't available here"), findsOneWidget);
      expect(find.textContaining('Record attendance'), findsOneWidget);
      expect(find.text('Review staff report'), findsOneWidget);
      expect(f.posts, isEmpty);
      await capture(tester, 'vm-teams-clock-out-refused');
    },
  );

  testWidgets(
    'server refusal (PRESENCE_EVIDENCE_REQUIRED) stays in the sheet as an error panel',
    (tester) async {
      final f = TeamsFixture()..clockOutError = 'PRESENCE_EVIDENCE_REQUIRED';
      await mount(tester, f, teams);
      await tester.tap(action('staff-jen'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('team-reason-field')),
        _tenWords,
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('team-reason-confirm')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('team-reason-error')), findsOneWidget);
      expect(find.text('Clock-out not recorded'), findsOneWidget);
      expect(
        find.textContaining('Review staff report → Record attendance'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('team-reason-sheet')), findsOneWidget);
    },
  );

  testWidgets('without attendance.edit the rows are read-only', (
    tester,
  ) async {
    final f = TeamsFixture()..capabilities = {'report.view': true};
    await mount(tester, f, teams);
    expect(find.text('Clock-In'), findsNothing);
    expect(find.text('Clock-out'), findsNothing);
    expect(chipText(tester, 'staff-lucy'), 'Not checked in');
  });

  testWidgets('Teams at 320dp and 2x text: no overflow, actions reachable', (
    tester,
  ) async {
    final f = TeamsFixture();
    await mount(tester, f, teams, size: const Size(320, 640), scale: 2);
    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(
      action('staff-jen'),
      200,
      scrollable: find.descendant(
        of: find.byKey(const ValueKey('vm-teams-list')),
        matching: find.byType(Scrollable),
      ),
    );
    await tester.ensureVisible(action('staff-jen'));
    await tester.pumpAndSettle();
    await capture(tester, 'vm-teams-320-2x');
    await tester.tap(action('staff-jen'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('team-reason-sheet')), findsOneWidget);
  });

  group('Event Details', () {
    testWidgets('bottom Qr-Code + Clock-In/Out open their screens', (
      tester,
    ) async {
      final f = TeamsFixture();
      await mount(
        tester,
        f,
        (e) => VenueEventDetail(event: e, style: ShiftVisualStyle.peach),
      );
      expect(find.text('Qr-Code'), findsOneWidget);
      expect(find.text('Clock-In/Out'), findsOneWidget);
      await capture(tester, 'vm-event-details');
      await tester.tap(find.text('Clock-In/Out'));
      await tester.pumpAndSettle();
      expect(find.byType(VenueTeamsScreen), findsOneWidget);
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Qr-Code'));
      await tester.pumpAndSettle();
      expect(find.byType(VenueStaffQrScreen), findsOneWidget);
    });

    testWidgets('hidden without report.view', (tester) async {
      final f = TeamsFixture()..capabilities = {};
      await mount(
        tester,
        f,
        (e) => VenueEventDetail(event: e, style: ShiftVisualStyle.peach),
      );
      expect(find.text('Qr-Code'), findsNothing);
      expect(find.text('Clock-In/Out'), findsNothing);
    });
  });

  group('Staff Qr-Code', () {
    Widget qr(VenueEvent e) => VenueStaffQrScreen(
      shiftId: e.id,
      viewer: (bytes) => Center(
        key: const ValueKey('fake-pdf'),
        child: Text('PDF ${bytes.length} bytes'),
      ),
    );

    testWidgets('renders the server attendance sheet (with its QR)', (
      tester,
    ) async {
      final f = TeamsFixture()
        ..actions = {
          'stage': 'pre_shift',
          'timesheetAvailableAt': _iso(DateTime.now()),
          'timesheet': 'available',
          'finalise': 'hidden',
          'document': {
            'kind': 'pre_shift',
            'fileId': 'sheet-1',
            'filename': 'sheet.pdf',
          },
          'preShiftDocument': {
            'kind': 'pre_shift',
            'fileId': 'sheet-1',
            'filename': 'sheet.pdf',
          },
        };
      await mount(tester, f, qr);
      expect(find.text('Staff Qr-Code'), findsOneWidget);
      expect(find.text('Your workspace'), findsOneWidget);
      expect(find.byKey(const ValueKey('fake-pdf')), findsOneWidget);
      expect(f.downloads, 1);
      expect(find.text('Back'), findsOneWidget);
      expect(find.byKey(const ValueKey('staff-qr-menu')), findsOneWidget);
      await capture(tester, 'vm-staff-qr-available');
    });

    testWidgets('before the sheet exists: truthful "not available yet"', (
      tester,
    ) async {
      final f = TeamsFixture()
        ..actions = {
          'stage': 'scheduled',
          'timesheetAvailableAt': _iso(DateTime(2030, 5, 4, 18, 45)),
          'timesheet': 'hidden',
          'finalise': 'hidden',
          'document': null,
          'preShiftDocument': null,
        };
      await mount(tester, f, qr);
      expect(find.text('QR not available yet'), findsOneWidget);
      expect(find.textContaining('available from'), findsOneWidget);
      expect(f.downloads, 0);
      expect(find.byKey(const ValueKey('fake-pdf')), findsNothing);
      await capture(tester, 'vm-staff-qr-not-yet');
    });

    testWidgets('preparing, closed window, invalid file', (tester) async {
      final f = TeamsFixture()
        ..actions = {
          'stage': 'pre_shift',
          'timesheetAvailableAt': _iso(DateTime.now()),
          'timesheet': 'preparing',
          'finalise': 'hidden',
          'document': null,
          'preShiftDocument': null,
        };
      await mount(tester, f, qr);
      expect(find.text('Preparing the shift QR'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);

      f.qrWindow = {
        'opensAt': _iso(f.start),
        'closesAt': _iso(f.end),
        'state': 'closed',
      };
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(find.text('QR window closed'), findsOneWidget);

      f.qrWindow = {};
      f.actions = {
        ...f.actions,
        'preShiftDocument': {
          'kind': 'pre_shift',
          'fileId': 'sheet-1',
          'filename': 'sheet.pdf',
        },
      };
      f.pdf = utf8.encode('<html>not a pdf</html>');
      await tester.pumpWidget(const SizedBox());
      await mount(tester, f, qr);
      expect(find.text('QR not available'), findsOneWidget);
      expect(find.byKey(const ValueKey('fake-pdf')), findsNothing);
    });
  });

  test('reason word count matches the server rule', () {
    expect(reasonWordCount(''), 0);
    expect(reasonWordCount('  - - -  '), 0);
    expect(reasonWordCount(_tenWords), greaterThanOrEqualTo(10));
    expect(reasonWordCount('a b c d e f g h i'), 9);
    expect(reasonWordCount('Ünïcode wörds count 1 2'), 5);
  });

  test('row action and chip mapping', () {
    final f = TeamsFixture();
    final rows = f.seats.map(ShiftReportStaffRow.fromJson).toList();
    expect(
      rows.map((r) => teamRowAction(r, canEdit: true, finalised: false)),
      [
        TeamRowAction.clockIn,
        TeamRowAction.clockIn,
        TeamRowAction.clockOut,
        null,
      ],
    );
    expect(
      rows.every(
        (r) => teamRowAction(r, canEdit: true, finalised: true) == null,
      ),
      isTrue,
    );
    final noShow = ShiftReportStaffRow.fromJson({
      ...f.seats.first,
      'assignmentStatus': 'no_show',
    });
    expect(teamRowAction(noShow, canEdit: true, finalised: false), isNull);
    expect(teamRowState(noShow).$1, 'Attendance missing');
  });

  testWidgets(
    'Teams poll: 30 s ±20 % background reads, rows kept with a notice on '
    'failure, nothing while backgrounded, foreground read on resume',
    (tester) async {
      final f = TeamsFixture();
      await mount(tester, f, teams);
      expect(f.reportReads, [null], reason: 'first load: user action');
      await tester.pump(const Duration(seconds: 23));
      expect(f.reportReads, hasLength(1), reason: 'never before 30 s − 20 %');
      await tester.pump(const Duration(seconds: 14));
      expect(f.reportReads, [null, '1'], reason: 'timer read = background');

      f.failReport = true;
      await tester.pump(const Duration(seconds: 37));
      await tester.pumpAndSettle();
      expect(f.reportReads, hasLength(3));
      expect(find.text('Lucy Example'), findsOneWidget);
      expect(find.text('4 people'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('stale-refresh-notice')),
        findsOneWidget,
      );
      expect(find.text('Team unavailable'), findsNothing);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump(const Duration(minutes: 10));
      expect(f.reportReads, hasLength(3), reason: 'no polling in background');

      f.failReport = false;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(f.reportReads, hasLength(4));
      expect(f.reportReads.last, isNull, reason: 'resume: user action');
      expect(find.byKey(const ValueKey('stale-refresh-notice')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Teams poll: a permanent refusal (404: no longer this manager\'s shift) '
    'drops the rows instead of keeping them with a notice',
    (tester) async {
      final f = TeamsFixture();
      await mount(tester, f, teams);
      expect(find.text('Lucy Example'), findsOneWidget);
      f
        ..failReport = true
        ..reportFailStatus = 404;
      await tester.pump(const Duration(seconds: 37));
      await tester.pumpAndSettle();
      expect(f.reportReads, hasLength(2));
      expect(find.text('Lucy Example'), findsNothing);
      expect(find.text('Team unavailable'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('stale-refresh-notice')),
        findsNothing,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Teams poll stops while another screen covers it', (
    tester,
  ) async {
    final f = TeamsFixture();
    await mount(tester, f, teams);
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    navigator.push(
      MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('x'))),
    );
    await tester.pumpAndSettle();
    final before = f.reportReads.length;
    await tester.pump(const Duration(minutes: 5));
    expect(f.reportReads, hasLength(before));
    navigator.pop();
    await tester.pumpAndSettle();
    expect(f.reportReads, hasLength(before + 1), reason: 'visible again');
    expect(f.reportReads.last, isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
