import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/theme/schedule_tokens.dart';
import 'package:rab_staff/core/widgets/schedule_feedback.dart';
import 'package:rab_staff/features/venue_manager/attendance_correction_sheet.dart';
import 'package:rab_staff/features/venue_manager/review_staff_report_screen.dart';
import 'package:rab_staff/features/venue_manager/shift_report.dart';
import 'package:rab_staff/features/venue_manager/shift_report_screen.dart';
import 'package:rab_staff/features/venue_manager/unusual_clock_in_warning.dart';
import 'package:rab_staff/features/venue_manager/report_document_screen.dart';
import 'package:rab_staff/features/venue_manager/report_ui.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';

final start = DateTime(2026, 10, 16, 15, 45);
final end = DateTime(2026, 10, 16, 22, 45);
final clockIn = DateTime(2026, 10, 16, 16, 0);

Map<String, dynamic> row({
  String id = 'staff-1',
  String name = 'Staff Test 1',
  String? attendanceId = 'att-1',
  String? status = 'missing_clock_out',
  DateTime? inAt,
  DateTime? outAt,
  String assignment = 'confirmed',
  bool reviewed = false,
  bool performanceReviewed = false,
  bool corrected = false,
  bool manuallyEntered = false,
}) => {
  'staffProfileId': id,
  'staffName': name,
  'roleName': 'Test Role 1',
  'scheduledStart': start.toUtc().toIso8601String(),
  'scheduledEnd': end.toUtc().toIso8601String(),
  'assignmentStatus': assignment,
  'attendanceId': attendanceId,
  'attendanceStatus': status,
  'clockInAt': inAt?.toUtc().toIso8601String(),
  'clockOutAt': outAt?.toUtc().toIso8601String(),
  'breakMinutes': null,
  'scheduledBreakMinutes': 30,
  // As the server computes it (`computeWorkedMinutes`): span minus the 30-minute scheduled break, once clocked out.
  'workedMinutes': inAt != null && outAt != null
      ? outAt.difference(inAt).inMinutes - 30
      : null,
  'corrected': corrected,
  'performanceReviewed': performanceReviewed,
  'attendanceReviewed': reviewed,
  'attendanceReviewedAt': reviewed
      ? end.add(const Duration(hours: 1)).toUtc().toIso8601String()
      : null,
  'attendanceReviewedByName': reviewed ? 'Venue Test' : null,
  'manuallyEntered': manuallyEntered,
  'attendanceVersion': attendanceId == null ? null : 'v-$attendanceId',
  'noShowConfirmed': assignment == 'no_show' && reviewed,
  'noShowConfirmableAt': start
      .add(const Duration(minutes: 30))
      .toUtc()
      .toIso8601String(),
};

Map<String, dynamic> report({
  required List<Map<String, dynamic>> staff,
  String displayStatus = 'needs_review',
  bool ready = false,
  String reportStatus = 'ready',
  String deliveryState = 'not_finalised',
  bool expired = false,
  String stage = 'started',
  bool timesheetReady = true,
  bool finalReady = false,
  bool? finalisable,
}) => _report(
  staff: staff,
  displayStatus: displayStatus,
  ready: ready,
  reportStatus: reportStatus,
  deliveryState: deliveryState,
  expired: expired,
  stage: stage,
  timesheetReady: timesheetReady,
  finalReady: finalReady,
  // Server rule (`isReportFinalisable`): resolved AND every seat's attendance reviewed.
  finalisable:
      finalisable ??
      (ready &&
          reportStatus != 'finalised' &&
          staff.every((r) => r['attendanceReviewed'] == true)),
);

Map<String, dynamic> _report({
  required List<Map<String, dynamic>> staff,
  required String displayStatus,
  required bool ready,
  required String reportStatus,
  required String deliveryState,
  required bool expired,
  required String stage,
  required bool timesheetReady,
  required bool finalReady,
  required bool finalisable,
}) => {
  'actions': {
    'stage': stage,
    'timesheetAvailableAt': start
        .subtract(const Duration(hours: 3))
        .toUtc()
        .toIso8601String(),
    'timesheet': stage == 'scheduled'
        ? 'hidden'
        : (timesheetReady ? 'available' : 'preparing'),
    'finalise': stage == 'started'
        ? (finalisable ? 'enabled' : 'disabled')
        : 'hidden',
    'document': stage == 'scheduled' || !timesheetReady
        ? null
        : finalReady
        ? {
            'kind': 'final',
            'fileId': 'f-final',
            'filename': 'final-timesheet.pdf',
          }
        : {
            'kind': 'pre_shift',
            'fileId': 'f-pre',
            'filename': 'shift-attendance-sheet.pdf',
          },
    'preShiftDocument': timesheetReady
        ? {
            'kind': 'pre_shift',
            'fileId': 'f-pre',
            'filename': 'shift-attendance-sheet.pdf',
          }
        : null,
    'finalDocumentPending': stage == 'finalised' && !finalReady,
  },
  'shiftId': 'shift-1',
  'venueName': 'Venue Test 1',
  'roleName': 'Test Role 1',
  'startsAt': start.toUtc().toIso8601String(),
  'endsAt': end.toUtc().toIso8601String(),
  'reportStatus': reportStatus,
  'finalisedAt': null,
  'staff': staff,
  'ready': ready,
  'finalisable': finalisable,
  'reviewsRemaining': staff
      .where((r) => r['attendanceReviewed'] != true)
      .length,
  'lifecycle': {
    'displayStatus': displayStatus,
    'displayLabel': displayStatus,
    'actionExpiresAt': end
        .add(const Duration(hours: 5))
        .toUtc()
        .toIso8601String(),
    'actionExpired': expired,
    'needsAttendanceReview': !ready,
    'needsAttention': expired,
    'deliveryState': deliveryState,
  },
  'qrWindow': {
    'opensAt': start
        .subtract(const Duration(minutes: 15))
        .toUtc()
        .toIso8601String(),
    'closesAt': end.add(const Duration(hours: 2)).toUtc().toIso8601String(),
    'state': 'closed',
  },
  'preShiftFile': {'fileId': 'f-pre', 'filename': 'roster.pdf'},
  'finalFile': null,
  'signOff': null,
};

class Fake {
  Fake(this.reportJson);
  Map<String, dynamic> reportJson;
  Map<String, dynamic>? review;
  bool reviewEditable = true;
  bool storageMissing = false;
  bool notPdf = false;

  /// Server-side effect of a confirmed correction / attendance review (the next report the server returns).
  Map<String, dynamic> Function()? afterCorrect;
  Map<String, dynamic> Function()? afterReview;
  Map<String, dynamic> Function()? afterRecord;
  Map<String, dynamic> Function()? afterNoShow;
  Map<String, dynamic> Function()? afterReopen;

  /// A rejection (status, body) for "Record attendance".
  (int, Map<String, dynamic>)? rejectRecord;

  /// Server latency for "Record attendance" (to observe the loading state).
  Duration recordDelay = Duration.zero;

  /// A rejection (status, message) the server returns instead of applying the write.
  (int, String)? rejectCorrect;

  /// When set, behaves like `AttendanceService.correct`: a `clockInAt` before this instant sent without
  /// `confirmUnusualClockIn: true` is refused with 409 `CLOCK_IN_CONFIRMATION_REQUIRED` (nothing applied).
  DateTime? earliestClockIn;
  (int, String)? rejectReview;
  final requests = <(String, String, Map<String, dynamic>?)>[];

  late final api = ApiClient(
    httpClient: MockClient((r) async {
      final path = r.url.path.replaceFirst('/rest/v1', '');
      final body = r.body.isEmpty
          ? null
          : jsonDecode(r.body) as Map<String, dynamic>;
      requests.add((r.method, path, body));
      if (path == '/auth/capabilities') {
        return _json({'report.view': true, 'report.export': true});
      }
      if (path.contains('/reviews/') && r.method == 'GET') {
        return _json({'review': review, 'editable': reviewEditable});
      }
      if (path.contains('/reviews/') && r.method == 'PUT') {
        review = {...body!, 'reviewerName': 'Venue Test'};
        return _json(review!);
      }
      if (path.endsWith('/finalise')) return _json(reportJson);
      if (path.endsWith('/attendance-review')) {
        final reject = rejectReview;
        if (reject != null) {
          return http.Response(
            jsonEncode({'message': reject.$2}),
            reject.$1,
            headers: {'content-type': 'application/json'},
          );
        }
        if (afterReview != null) reportJson = afterReview!();
        return _json(reportJson);
      }
      if (path.endsWith('/record-attendance')) {
        if (recordDelay > Duration.zero) await Future<void>.delayed(recordDelay);
        final reject = rejectRecord;
        if (reject != null) {
          return http.Response(
            jsonEncode(reject.$2),
            reject.$1,
            headers: {'content-type': 'application/json'},
          );
        }
        if (afterRecord != null) reportJson = afterRecord!();
        return _json(reportJson);
      }
      if (path.endsWith('/confirm-no-show')) {
        if (afterNoShow != null) reportJson = afterNoShow!();
        return _json(reportJson);
      }
      if (path.endsWith('/reopen-no-show')) {
        if (afterReopen != null) reportJson = afterReopen!();
        return _json(reportJson);
      }
      if (path.startsWith('/attendance/report/shift/')) {
        return _json(reportJson);
      }
      if (path.endsWith('/correct')) {
        final earliest = earliestClockIn;
        if (earliest != null &&
            body?['field'] == 'clockInAt' &&
            body?['confirmUnusualClockIn'] != true &&
            DateTime.parse(body!['newValue'] as String).isBefore(earliest)) {
          return http.Response(
            jsonEncode({
              'statusCode': 409,
              'code': 'CLOCK_IN_CONFIRMATION_REQUIRED',
              'message':
                  'This time is earlier than the normal allowance. Please check before continuing.',
              'earliestAllowed': earliest.toUtc().toIso8601String(),
              'enteredTime': body['newValue'],
            }),
            409,
            headers: {'content-type': 'application/json'},
          );
        }
        final reject = rejectCorrect;
        if (reject != null) {
          return http.Response(
            jsonEncode({'message': reject.$2}),
            reject.$1,
            headers: {'content-type': 'application/json'},
          );
        }
        if (afterCorrect != null) reportJson = afterCorrect!();
        return _json({});
      }
      if (path.startsWith('/files/') && path.endsWith('/download')) {
        if (storageMissing) {
          return http.Response('{"message":"File not found."}', 404);
        }
        final name = path.contains('f-final')
            ? 'final-timesheet.pdf'
            : 'shift-attendance-sheet.pdf';
        return http.Response.bytes(
          notPdf ? '<html>nope</html>'.codeUnits : '%PDF-1.4 fake'.codeUnits,
          200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="$name"',
          },
        );
      }
      return http.Response('{"message":"unexpected $path"}', 404);
    }),
  );

  static http.Response _json(Object o) => http.Response(
    jsonEncode(o),
    200,
    headers: {'content-type': 'application/json'},
  );

  Iterable<(String, String, Map<String, dynamic>?)> writes() =>
      requests.where((r) => r.$1 != 'GET');
}

final _boundary = GlobalKey();
const _capture = bool.fromEnvironment('VM_VISUAL_CAPTURE');

/// Evidence capture (only with `--dart-define=VM_VISUAL_CAPTURE=true`): a widget-test render with real fonts, written to
/// `.qa-screenshots/report-review/`. Not an emulator screenshot.
Future<void> shot(WidgetTester tester, String name) async {
  expect(tester.takeException(), isNull);
  if (!_capture) return;
  await tester.runAsync(() async {
    final image =
        await (_boundary.currentContext!.findRenderObject()
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory('.qa-screenshots/report-review').create(recursive: true);
    await File(
      '.qa-screenshots/report-review/$name.png',
    ).writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

Future<VenueManagerProvider> mount(
  WidgetTester tester,
  Fake f,
  Widget page, {
  Size size = const Size(1080, 4600),
  double ratio = 2.6,
  double textScale = 1,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = ratio;
  addTearDown(tester.view.reset);
  final p = VenueManagerProvider(f.api, 'user-1')
    ..capabilities = {'report.view': true, 'report.export': true};
  await tester.pumpWidget(
    ChangeNotifierProvider.value(
      value: p,
      child: MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: RepaintBoundary(key: _boundary, child: child!),
        ),
        home: page,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return p;
}

ShiftReportDetail detail(Map<String, dynamic> json) =>
    ShiftReportDetail.fromJson(json);

Future<void> pickDay(WidgetTester tester, String day) async {
  await tester.tap(find.byKey(const Key('correction-date')));
  await tester.pumpAndSettle();
  await tester.tap(find.text(day));
  await tester.tap(find.text('OK'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  setUpAll(() async {
    if (!_capture) return;
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

  group('Shift report', () {
    testWidgets(
      'missing clock-outs: amber notice, Needs review badges, Missing in amber, Finalise disabled',
      (tester) async {
        final f = Fake(
          report(
            staff: [
              row(inAt: clockIn),
              row(id: 'staff-2', name: 'Staff Test 2', inAt: clockIn),
            ],
          ),
        );
        await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
        expect(find.text('2 clock-out times need checking'), findsOneWidget);
        expect(find.text('Needs review'), findsNWidgets(2));
        expect(find.text('Missing'), findsNWidgets(2));
        expect(find.text('0 of 2 reviewed'), findsOneWidget);
        final finalise = tester.widget<TextButton>(
          find.descendant(
            of: find.byKey(const Key('finalise-and-send')),
            matching: find.byType(TextButton),
          ),
        );
        expect(finalise.onPressed, isNull);
      },
    );

    testWidgets(
      'waiting for clock-in: lavender Waiting badges and the download notice; no Finalise yet',
      (tester) async {
        final f = Fake(
          report(
            staff: [row(attendanceId: null, status: null)],
            displayStatus: 'waiting_clock_in',
            stage: 'pre_shift',
          ),
        );
        await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
        expect(find.text('Waiting staff to Clock-in'), findsOneWidget);
        expect(find.text('Waiting'), findsOneWidget);
        expect(find.byKey(const Key('finalise-and-send')), findsNothing);
        expect(find.byKey(const Key('open-timesheet')), findsOneWidget);
      },
    );

    testWidgets(
      'Reviewed only after the attendance review is saved; one outstanding review keeps Finalise disabled',
      (tester) async {
        final f = Fake(
          report(
            staff: [
              row(
                inAt: clockIn,
                outAt: end,
                status: 'clocked_out',
                reviewed: true,
              ),
              row(
                id: 'staff-2',
                name: 'Staff Test 2',
                inAt: clockIn,
                outAt: end,
                status: 'clocked_out',
              ),
            ],
            displayStatus: 'ready_to_finalise',
            ready: true,
          ),
        );
        await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
        expect(find.text('Reviewed'), findsOneWidget);
        expect(find.text('Awaiting review'), findsOneWidget);
        expect(find.text('1 of 2 reviewed'), findsOneWidget);
        expect(enabled(tester, 'finalise-and-send'), isFalse);
        expect(find.text('1 attendance review remaining'), findsOneWidget);
        expect(finaliseColor(tester), ReportTokens.disabledBg);
        await shot(tester, '08-one-review-remaining-finalise-grey');
      },
    );

    testWidgets(
      'all five reviewed (incl. a corrected clock-out and a reviewed no-show): Finalise & send is enabled and dark',
      (tester) async {
        final f = Fake(
          report(
            staff: [
              for (var i = 1; i <= 3; i++)
                row(
                  id: 'staff-$i',
                  name: 'Staff Test $i',
                  inAt: clockIn,
                  outAt: end,
                  status: 'under_review',
                  reviewed: true,
                  corrected: i == 3,
                ),
              row(
                id: 'staff-4',
                name: 'Staff Test 4',
                inAt: clockIn,
                outAt: end,
                status: 'clocked_out',
                reviewed: true,
              ),
              row(
                id: 'staff-5',
                name: 'Staff Test 5',
                attendanceId: null,
                status: null,
                assignment: 'no_show',
                reviewed: true,
              ),
            ],
            displayStatus: 'ready_to_finalise',
            ready: true,
          ),
        );
        await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
        expect(find.text('5 of 5 reviewed'), findsOneWidget);
        await shot(tester, '07-five-of-five-reviewed');
        await tester.scrollUntilVisible(
          find.text('No-show · Confirmed'),
          300,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text('No-show · Confirmed'), findsOneWidget);
        expect(enabled(tester, 'finalise-and-send'), isTrue);
        expect(finaliseColor(tester), ReportTokens.navy);
        expect(find.byKey(const Key('finalise-blocked-reason')), findsNothing);
      },
    );

    testWidgets(
      'a saved performance rating alone never shows Reviewed or unlocks Finalise',
      (tester) async {
        final f = Fake(
          report(
            staff: [
              row(
                inAt: clockIn,
                outAt: end,
                status: 'clocked_out',
                performanceReviewed: true,
              ),
            ],
            displayStatus: 'needs_review',
            ready: true,
          ),
        );
        await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
        expect(find.text('Reviewed'), findsNothing);
        expect(find.text('0 of 1 reviewed'), findsOneWidget);
        expect(enabled(tester, 'finalise-and-send'), isFalse);
        expect(find.text('1 attendance review remaining'), findsWidgets);
      },
    );

    test('badge rules never invent a state', () {
      ShiftReportStaffRow r(Map<String, dynamic> j) =>
          ShiftReportStaffRow.fromJson(j);
      expect(
        staffReportBadge(
          r(row(assignment: 'no_show', attendanceId: null, status: null)),
          ended: true,
        ).$1,
        'Attendance missing · Needs review',
      );
      expect(
        staffReportBadge(
          r(
            row(
              assignment: 'no_show',
              attendanceId: null,
              status: null,
              reviewed: true,
            ),
          ),
          ended: true,
        ).$1,
        'No-show · Confirmed',
      );
      expect(
        staffReportBadge(
          r(
            row(
              inAt: clockIn,
              outAt: end,
              status: 'under_review',
              corrected: true,
            ),
          ),
          ended: true,
        ).$1,
        'Corrected · Awaiting review',
      );
      // A missing clock-out is never green, whatever else is saved.
      expect(
        staffReportBadge(
          r(row(inAt: clockIn, performanceReviewed: true)),
          ended: true,
        ).$1,
        'Needs review',
      );
      expect(
        staffReportBadge(
          r(row(inAt: clockIn, outAt: end, status: 'approved', reviewed: true)),
          ended: true,
          finalised: true,
        ).$1,
        'Finalised',
      );
      expect(
        staffReportBadge(
          r(row(inAt: clockIn, status: 'clocked_in')),
          ended: true,
        ).$1,
        'Clocked in',
      );
      expect(
        staffReportBadge(
          r(row(attendanceId: null, status: null)),
          ended: true,
        ).$1,
        'Attendance missing · Needs review',
      );
      expect(
        staffReportBadge(
          r(row(attendanceId: null, status: null)),
          ended: false,
        ).$1,
        'Waiting',
      );
    });
  });

  group('Attendance correction', () {
    testWidgets(
      'missing clock-out opens on Clock out with the amber warning and the clock-in day',
      (tester) async {
        final json = report(staff: [row(inAt: clockIn)]);
        final f = Fake(json);
        final d = detail(json);
        await mount(
          tester,
          f,
          ReviewStaffReportScreen(report: d, row: d.staff.first),
        );
        expect(find.text('Clock-out time is missing'), findsOneWidget);
        expect(find.text('Select time'), findsOneWidget);
        expect(find.text('Fri 16 Oct'), findsOneWidget);
      },
    );

    testWidgets(
      'an overnight clock-out is saved on the chosen next day, never on the shift start date',
      (tester) async {
        final json = report(
          staff: [
            row(
              inAt: clockIn,
              outAt: DateTime(2026, 10, 16, 23, 0),
              status: 'clocked_out',
            ),
          ],
        );
        final f = Fake(json);
        final d = detail(json);
        await mount(
          tester,
          f,
          ReviewStaffReportScreen(report: d, row: d.staff.first),
        );
        await tester.tap(find.byKey(const Key('segment-Clock out')));
        await tester.pumpAndSettle();
        await pickDay(tester, '17');
        expect(
          find.text('Will be saved as Sat 17 Oct 2026, 23:00'),
          findsOneWidget,
        );
        await tester.enterText(
          find.byKey(const Key('correction-reason')),
          'staff has missed the clock out',
        );
        await tester.tap(find.text('Save correction'));
        await tester.pumpAndSettle();
        final write = f.writes().single;
        expect(write.$2, '/attendance/att-1/correct');
        expect(write.$3, {
          'field': 'clockOutAt',
          'newValue': DateTime(2026, 10, 17, 23, 0).toUtc().toIso8601String(),
          'reason': 'staff has missed the clock out',
        });
      },
    );

    testWidgets('the server-required reason is enforced before sending', (
      tester,
    ) async {
      final json = report(
        staff: [row(inAt: clockIn, outAt: end, status: 'clocked_out')],
      );
      final f = Fake(json);
      final d = detail(json);
      await mount(
        tester,
        f,
        ReviewStaffReportScreen(report: d, row: d.staff.first),
      );
      await tester.tap(find.text('Save correction'));
      await tester.pumpAndSettle();
      expect(
        find.text('Please explain this change in at least 10 characters.'),
        findsOneWidget,
      );
      expect(f.writes(), isEmpty);
    });

    testWidgets('a clock-out before clock-in is explained and never sent', (
      tester,
    ) async {
      final json = report(
        staff: [
          row(
            inAt: clockIn,
            outAt: DateTime(2026, 10, 17, 3, 15),
            status: 'clocked_out',
          ),
        ],
      );
      final f = Fake(json);
      final d = detail(json);
      await mount(
        tester,
        f,
        ReviewStaffReportScreen(report: d, row: d.staff.first),
      );
      await tester.tap(find.byKey(const Key('segment-Clock out')));
      await tester.pumpAndSettle();
      await pickDay(tester, '16');
      await tester.enterText(
        find.byKey(const Key('correction-reason')),
        'staff has missed the clock out',
      );
      await tester.tap(find.text('Save correction'));
      await tester.pumpAndSettle();
      expect(find.textContaining('This is before clock in'), findsOneWidget);
      expect(f.writes(), isEmpty);
    });

    testWidgets(
      'no attendance record: Attendance missing, both decisions offered, nothing is created without the manager',
      (tester) async {
        final json = report(staff: [row(attendanceId: null, status: null)]);
        final f = Fake(json);
        final d = detail(json);
        await mount(
          tester,
          f,
          ReviewStaffReportScreen(report: d, row: d.staff.first),
        );
        expect(find.text('Attendance missing · Needs review'), findsOneWidget);
        expect(find.text('Attendance requires review'), findsOneWidget);
        expect(find.byKey(const Key('record-attendance')), findsOneWidget);
        expect(find.byKey(const Key('confirm-no-show')), findsOneWidget);
        expect(find.byKey(const Key('save-review-screen')), findsNothing);
        expect(find.byKey(const Key('mark-attendance-reviewed')), findsNothing);
        expect(f.writes(), isEmpty);
      },
    );

    testWidgets(
      'forgotten clock-out, end to end: correction saved -> report shows the SAVED time as Corrected · Awaiting review -> Mark reviewed -> back on the report: Reviewed and Finalise enabled',
      (tester) async {
        final missing = row(inAt: clockIn);
        final corrected = row(
          inAt: clockIn,
          outAt: end,
          status: 'under_review',
          corrected: true,
        );
        final reviewed = row(
          inAt: clockIn,
          outAt: end,
          status: 'under_review',
          corrected: true,
          reviewed: true,
        );
        final f = Fake(report(staff: [missing]));
        f.afterCorrect = () => report(
          staff: [corrected],
          ready: true,
          displayStatus: 'needs_review',
        );
        f.afterReview = () => report(
          staff: [reviewed],
          ready: true,
          displayStatus: 'ready_to_finalise',
        );
        await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
        expect(find.text('Needs review'), findsOneWidget);
        expect(find.text('1 clock-out time missing'), findsOneWidget);
        expect(enabled(tester, 'finalise-and-send'), isFalse);
        await shot(tester, '01-report-missing-clock-out');

        await tester.ensureVisible(
          find.byKey(const Key('review-hours-staff-1')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('review-hours-staff-1')));
        await tester.pumpAndSettle();
        // Before the clock-out exists the review cannot be completed.
        expect(enabled(tester, 'mark-attendance-reviewed'), isFalse);
        expect(
          find.text('Add the clock-out time as a correction first.'),
          findsOneWidget,
        );
        await shot(tester, '02-review-hours-missing-clock-out');

        await tester.tap(find.byKey(const Key('correction-time')));
        await tester.pumpAndSettle();
        await tester.tap(find.byType(TextButton).last); // OK on the time picker
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('correction-reason')),
          'Staff forgot to clock out; departure confirmed by the Venue Manager.',
        );
        await tester.tap(find.byKey(const Key('save-review-screen')));
        await tester.pumpAndSettle();

        // Still on the review screen, now showing what the SERVER stored.
        expect(
          find.byKey(const Key('correction-confirmation')),
          findsOneWidget,
        );
        expect(
          find.textContaining('Clock-out saved: Fri 16 Oct, 22:45'),
          findsOneWidget,
        );
        expect(find.text('Corrected · Awaiting review'), findsOneWidget);
        expect(find.text('22:45'), findsOneWidget);
        expect(find.text('Reviewed'), findsNothing);
        expect(enabled(tester, 'mark-attendance-reviewed'), isTrue);
        await shot(tester, '03-correction-saved-awaiting-review');

        await tester.tap(find.byKey(const Key('mark-attendance-reviewed')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        // Owner decision: the mobile app shows no review success toast; the
        // report itself shows the result.
        expect(
          find.byKey(const ValueKey('schedule-toast-success')),
          findsNothing,
        );
        await tester.pumpAndSettle();
        expect(f.writes().map((w) => w.$2).toList(), [
          '/attendance/att-1/correct',
          '/attendance/report/shift/shift-1/staff/staff-1/attendance-review',
        ]);
        // Back on the reloaded report.
        expect(find.byType(ShiftReportScreen), findsOneWidget);
        expect(find.byType(ReviewStaffReportScreen), findsNothing);
        expect(find.text('Reviewed'), findsOneWidget);
        expect(find.text('1 of 1 reviewed'), findsOneWidget);
        expect(enabled(tester, 'finalise-and-send'), isTrue);
        expect(finaliseColor(tester), ReportTokens.navy);
        await shot(tester, '04-reviewed-finalise-enabled');
      },
    );

    testWidgets(
      'small Android screen (320x640, text x1.3): report and review hours lay out without overflow',
      (tester) async {
        final json = report(
          staff: [
            row(inAt: clockIn),
            row(
              id: 'staff-2',
              name: 'Staff Test With A Long Family Name',
              inAt: clockIn,
              outAt: end,
              status: 'under_review',
              corrected: true,
            ),
          ],
        );
        final f = Fake(json);
        await mount(
          tester,
          f,
          const ShiftReportScreen(shiftId: 'shift-1'),
          size: const Size(640, 1280),
          ratio: 2,
          textScale: 1.3,
        );
        expect(tester.takeException(), isNull);
        expect(find.byKey(const Key('finalise-and-send')), findsOneWidget);
        await shot(tester, '05-small-screen-report');
        final d = detail(json);
        await mount(
          tester,
          f,
          ReviewStaffReportScreen(report: d, row: d.staff[1]),
          size: const Size(640, 1280),
          ratio: 2,
          textScale: 1.3,
        );
        expect(tester.takeException(), isNull);
        expect(find.text('Corrected · Awaiting review'), findsOneWidget);
        await shot(tester, '06-small-screen-review-hours');
      },
    );

    testWidgets(
      'a rejected correction is shown as an error: no confirmation, no Reviewed, nothing turns green',
      (tester) async {
        final json = report(staff: [row(inAt: clockIn)]);
        final f = Fake(json)
          ..rejectCorrect = (
            409,
            'The clock-out cannot be recorded until the shift has ended.',
          );
        final d = detail(json);
        await mount(
          tester,
          f,
          ReviewStaffReportScreen(report: d, row: d.staff.first),
        );
        await tester.tap(find.byKey(const Key('correction-time')));
        await tester.pumpAndSettle();
        await tester.tap(find.byType(TextButton).last);
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('correction-reason')),
          'Staff forgot to clock out at the end of service.',
        );
        await tester.tap(find.byKey(const Key('save-review-screen')));
        await tester.pumpAndSettle();
        expect(
          find.text(
            'The clock-out cannot be recorded until the shift has ended.',
          ),
          findsOneWidget,
        );
        expect(find.byKey(const Key('correction-confirmation')), findsNothing);
        expect(find.text('Review saved.'), findsNothing);
        expect(find.text('Needs review'), findsOneWidget);
        expect(enabled(tester, 'mark-attendance-reviewed'), isFalse);
      },
    );

    testWidgets(
      'a rejected attendance review is shown as an error and the screen stays open',
      (tester) async {
        final json = report(
          staff: [row(inAt: clockIn, outAt: end, status: 'clocked_out')],
          ready: true,
        );
        final f = Fake(json)
          ..rejectReview = (
            409,
            'This shift report has been finalised; attendance can no longer be reviewed.',
          );
        final d = detail(json);
        await mount(
          tester,
          f,
          ReviewStaffReportScreen(report: d, row: d.staff.first),
        );
        await tester.tap(find.byKey(const Key('mark-attendance-reviewed')));
        // The failure is a temporary error toast (checked before it expires).
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('schedule-toast-error')),
            matching: find.text(
              'This shift report has been finalised; attendance can no longer be reviewed.',
            ),
          ),
          findsOneWidget,
        );
        expect(find.text('Attendance reviewed'), findsNothing);
        await tester.pumpAndSettle();
        expect(find.byType(ReviewStaffReportScreen), findsOneWidget);
        expect(find.text('Awaiting review'), findsOneWidget);
      },
    );

    testWidgets('a still-clocked-in seat cannot be marked reviewed', (
      tester,
    ) async {
      final json = report(
        staff: [row(inAt: clockIn, status: 'clocked_in')],
      );
      final f = Fake(json);
      final d = detail(json);
      await mount(
        tester,
        f,
        ReviewStaffReportScreen(report: d, row: d.staff.first),
      );
      expect(find.text('Clocked in'), findsOneWidget);
      expect(enabled(tester, 'mark-attendance-reviewed'), isFalse);
      expect(find.byKey(const Key('review-blocked-reason')), findsOneWidget);
    });
  });

  // Owner brief 2026-11-15 ("Compact attendance correction warning"): the server refuses a clock-in earlier than the
  // seat's start − CLOCK_IN_EARLY_MINUTES with 409 CLOCK_IN_CONFIRMATION_REQUIRED unless confirmed; the app shows the
  // review screen's own AlertDialog (Edit / Confirm) and resends with `confirmUnusualClockIn: true` only on Confirm.
  group('Unusual clock-in correction (owner brief 2026-11-15)', () {
    // Shift 15:45, allowance 15 minutes → earliest allowed 15:30 (the server's rule, mirrored by the Fake).
    final earliest = start.subtract(const Duration(minutes: 15));
    const reason = 'Staff arrived early; start confirmed by the manager.';

    Future<Fake> openRecorded(WidgetTester tester) async {
      final json = report(
        staff: [row(inAt: clockIn, outAt: end, status: 'clocked_out')],
      );
      final f = Fake(json)..earliestClockIn = earliest;
      final d = detail(json);
      await mount(
        tester,
        f,
        ReviewStaffReportScreen(report: d, row: d.staff.first),
      );
      return f;
    }

    /// Types a clock-in time through the time picker's keyboard entry (12-hour test locale).
    Future<void> enterClockIn(
      WidgetTester tester,
      String hour,
      String minute, {
      required bool am,
    }) async {
      await tester.tap(find.byKey(const Key('correction-time')));
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(Icons.keyboard_outlined));
      await tester.pumpAndSettle();
      final fields = find.descendant(
        of: find.byType(Dialog),
        matching: find.byType(TextField),
      );
      await tester.enterText(fields.first, hour);
      await tester.enterText(fields.last, minute);
      await tester.tap(find.text(am ? 'AM' : 'PM'));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
    }

    /// Saves the correction. While the warning is open the Save button keeps its busy spinner (behind the modal
    /// barrier), so this pumps frames instead of waiting for the screen to settle.
    Future<void> saveWithReason(WidgetTester tester) async {
      await tester.enterText(
        find.byKey(const Key('correction-reason')),
        reason,
      );
      await tester.tap(find.byKey(const Key('save-review-screen')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
    }

    final dialog = find.byKey(const Key('unusual-clock-in-dialog'));

    testWidgets('a normal correction is saved with no warning', (tester) async {
      final f = await openRecorded(tester);
      await enterClockIn(tester, '3', '50', am: false); // 15:50
      await saveWithReason(tester);
      await tester.pumpAndSettle();
      expect(dialog, findsNothing);
      final write = f.writes().single;
      expect(write.$3, {
        'field': 'clockInAt',
        'newValue': DateTime(2026, 10, 16, 15, 50).toUtc().toIso8601String(),
        'reason': reason,
      });
      expect(find.byKey(const Key('correction-confirmation')), findsOneWidget);
    });

    testWidgets(
      'a correction exactly at the earliest allowed time shows no warning',
      (tester) async {
        final f = await openRecorded(tester);
        await enterClockIn(tester, '3', '30', am: false); // 15:30 == earliest
        await saveWithReason(tester);
        await tester.pumpAndSettle();
        expect(dialog, findsNothing);
        expect(f.writes().single.$3?['confirmUnusualClockIn'], isNull);
        expect(
          find.byKey(const Key('correction-confirmation')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'an earlier correction shows the compact warning: title, one sentence, the two times, Edit and Confirm',
      (tester) async {
        final f = await openRecorded(tester);
        await enterClockIn(tester, '5', '00', am: true); // 05:00
        await saveWithReason(tester);
        expect(dialog, findsOneWidget);
        Finder inDialog(Finder m) => find.descendant(of: dialog, matching: m);
        expect(inDialog(find.text('Unusual clock-in time')), findsOneWidget);
        expect(
          inDialog(
            find.text(
              'This time is earlier than the normal allowance. Please check before continuing.',
            ),
          ),
          findsOneWidget,
        );
        expect(inDialog(find.text('Earliest allowed')), findsOneWidget);
        expect(inDialog(find.text('15:30')), findsOneWidget);
        expect(inDialog(find.text('Entered time')), findsOneWidget);
        expect(inDialog(find.text('05:00')), findsOneWidget);
        expect(
          inDialog(find.byIcon(Icons.warning_amber_rounded)),
          findsOneWidget,
        );
        expect(inDialog(find.byType(TextButton)), findsOneWidget); // Edit
        expect(inDialog(find.byType(FilledButton)), findsOneWidget); // Confirm
        expect(inDialog(find.text('Edit')), findsOneWidget);
        expect(inDialog(find.text('Confirm')), findsOneWidget);
        // Nothing else to fill in: no reason input, no choices, no extra step.
        expect(inDialog(find.byType(TextField)), findsNothing);
        expect(inDialog(find.byType(Checkbox)), findsNothing);
        expect(
          inDialog(find.byWidgetPredicate((w) => w is Radio)),
          findsNothing,
        );
        // The refused request was the only write; nothing saved yet.
        expect(f.writes().single.$3?['confirmUnusualClockIn'], isNull);
        expect(find.byKey(const Key('correction-confirmation')), findsNothing);
        await shot(tester, '07-unusual-clock-in-warning');
      },
    );

    testWidgets(
      'Edit closes the warning and returns to the form with the entered time and reason kept',
      (tester) async {
        final f = await openRecorded(tester);
        await enterClockIn(tester, '5', '00', am: true);
        await saveWithReason(tester);
        await tester.tap(find.byKey(const Key('unusual-clock-in-edit')));
        await tester.pumpAndSettle();
        expect(dialog, findsNothing);
        expect(
          find.descendant(
            of: find.byKey(const Key('correction-time')),
            matching: find.text('05:00'),
          ),
          findsOneWidget,
        );
        expect(
          find.text('Will be saved as Fri 16 Oct 2026, 05:00'),
          findsOneWidget,
        );
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('correction-reason')))
              .controller!
              .text,
          reason,
        );
        expect(f.writes(), hasLength(1)); // nothing resent
        expect(find.byKey(const Key('correction-confirmation')), findsNothing);
        expect(
          find.byType(ScheduleMessageCard),
          findsNothing,
        ); // no error either
      },
    );

    testWidgets(
      'Confirm sends the same correction once more with the explicit confirmation, and it is saved',
      (tester) async {
        final f = await openRecorded(tester);
        await enterClockIn(tester, '5', '00', am: true);
        await saveWithReason(tester);
        await tester.tap(find.byKey(const Key('unusual-clock-in-confirm')));
        await tester.pumpAndSettle();
        expect(dialog, findsNothing);
        final writes = f.writes().toList();
        expect(writes, hasLength(2));
        final sent = {
          'field': 'clockInAt',
          'newValue': DateTime(2026, 10, 16, 5, 0).toUtc().toIso8601String(),
          'reason': reason,
        };
        expect(writes[0].$3, sent);
        expect(writes[1].$2, '/attendance/att-1/correct');
        expect(writes[1].$3, {...sent, 'confirmUnusualClockIn': true});
        expect(
          find.byKey(const Key('correction-confirmation')),
          findsOneWidget,
        );
      },
    );

    test(
      'only CLOCK_IN_CONFIRMATION_REQUIRED (409) with both times opens the warning',
      () {
        final body = {
          'code': 'CLOCK_IN_CONFIRMATION_REQUIRED',
          'earliestAllowed': '2026-10-16T08:45:00.000Z',
          'enteredTime': '2026-10-16T05:00:00.000Z',
        };
        final w = UnusualClockInWarning.fromError(
          ApiException(409, 'x', body: body),
        );
        expect(w?.earliestAllowed, DateTime.utc(2026, 10, 16, 8, 45));
        expect(w?.enteredTime, DateTime.utc(2026, 10, 16, 5));
        expect(
          UnusualClockInWarning.fromError(ApiException(422, 'x', body: body)),
          isNull,
        );
        expect(
          UnusualClockInWarning.fromError(
            ApiException(
              409,
              'x',
              body: {...body, 'code': 'INVALID_CLOCK_OUT_TIME'},
            ),
          ),
          isNull,
        );
        expect(
          UnusualClockInWarning.fromError(
            ApiException(
              409,
              'x',
              body: {'code': 'CLOCK_IN_CONFIRMATION_REQUIRED'},
            ),
          ),
          isNull,
        );
        expect(UnusualClockInWarning.fromError(Exception('x')), isNull);
      },
    );

    for (final (label, size, ratio, scale, wide) in [
      (
        'small phone 320x640, text x1.3',
        const Size(640, 1280),
        2.0,
        1.3,
        false,
      ),
      ('wide screen 1280x800', const Size(2560, 1600), 2.0, 1.0, true),
    ]) {
      testWidgets('the warning lays out without overflow on a $label', (
        tester,
      ) async {
        bool? result;
        await mount(
          tester,
          Fake(report(staff: [row()])),
          Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async => result = await confirmUnusualClockIn(
                  context,
                  UnusualClockInWarning(
                    DateTime(2026, 10, 16, 8, 45),
                    DateTime(2026, 10, 16, 5, 0),
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
          size: size,
          ratio: ratio,
          textScale: scale,
        );
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(dialog, findsOneWidget);
        expect(find.text('08:45'), findsOneWidget);
        expect(find.text('05:00'), findsOneWidget);
        final screen =
            Offset.zero &
            (tester.view.physicalSize / tester.view.devicePixelRatio);
        // Both actions stay on screen (the content scrolls instead of pushing them off).
        for (final key in [
          'unusual-clock-in-edit',
          'unusual-clock-in-confirm',
        ]) {
          final button = tester.getRect(find.byKey(Key(key)));
          expect(screen.contains(button.topLeft), isTrue, reason: key);
          expect(screen.contains(button.bottomRight), isTrue, reason: key);
        }
        if (wide) {
          // Compact on a large screen: a standard narrow dialog, never a full-width sheet. (Not asserted on the small
          // phone: the test font draws every glyph as a full square, which inflates text height well beyond real fonts.)
          final box = tester.getSize(
            find.descendant(of: dialog, matching: find.byType(Material)).first,
          );
          expect(box.width, lessThan(600));
          expect(box.height, lessThan(screen.height * 0.6));
        }
        // Dismissing it (tap outside) is the same as Edit: not confirmed.
        await tester.tapAt(const Offset(4, 4));
        await tester.pumpAndSettle();
        expect(dialog, findsNothing);
        expect(result, isFalse);
      });
    }
  });

  group('Manual attendance and no-show (owner rule 2026-10-21)', () {
    // A seat the worker provisionally marked as a no-show: no attendance, not reviewed.
    Map<String, dynamic> provisional() =>
        row(attendanceId: null, status: null, assignment: 'no_show');
    Map<String, dynamic> confirmedNoShow() => row(
      attendanceId: null,
      status: null,
      assignment: 'no_show',
      reviewed: true,
    );
    Map<String, dynamic> recorded() => {
      ...row(
        attendanceId: 'att-9',
        inAt: DateTime(2026, 10, 16, 16, 5),
        outAt: DateTime(2026, 10, 16, 22, 40),
        status: 'under_review',
        assignment: 'completed',
        corrected: true,
        manuallyEntered: true,
      ),
      'breakMinutes': 30,
      'clockOutMethod': 'manager_correction',
    };

    Future<void> openReview(
      WidgetTester tester,
      Fake f, {
      Size size = const Size(1080, 4600),
      double ratio = 2.6,
      double textScale = 1,
    }) async {
      final d = detail(f.reportJson);
      await mount(
        tester,
        f,
        // A fresh State per mount: the screen keeps the report it was opened with.
        ReviewStaffReportScreen(
          key: UniqueKey(),
          report: d,
          row: d.staff.first,
        ),
        size: size,
        ratio: ratio,
        textScale: textScale,
      );
    }

    Future<void> openSheet(WidgetTester tester) async {
      await tester.tap(find.byKey(const Key('record-attendance')));
      await tester.pumpAndSettle();
      expect(find.byType(AttendanceEntrySheet), findsOneWidget);
    }

    /// Date picker OK (the scheduled day it starts on), then time picker OK at the dial it starts on.
    Future<void> pickAt(WidgetTester tester, String key) async {
      await tester.ensureVisible(find.byKey(Key(key)));
      await tester.tap(find.byKey(Key(key)));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
    }

    Future<void> chooseReason(WidgetTester tester, String label) async {
      await tester.ensureVisible(find.byKey(const Key('entry-reason')));
      await tester.tap(find.byKey(const Key('entry-reason')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(label).last);
      await tester.pumpAndSettle();
    }

    Future<void> tapSave(WidgetTester tester) async {
      await tester.ensureVisible(find.byKey(const Key('save-attendance')));
      await tester.tap(find.byKey(const Key('save-attendance')));
    }

    testWidgets(
      'provisional no-show: "Attendance missing · Needs review", the amber panel and both actions (never "No-show")',
      (tester) async {
        final f = Fake(report(staff: [provisional()], ready: true));
        await openReview(tester, f);
        expect(find.text('Attendance missing · Needs review'), findsOneWidget);
        expect(find.textContaining('No-show ·'), findsNothing);
        expect(find.text('Attendance requires review'), findsOneWidget);
        expect(
          find.text(
            'No clock-in or clock-out was recorded for this shift. If the staff member worked, enter their verified attendance times. Otherwise, confirm the no-show.',
          ),
          findsOneWidget,
        );
        final record = tester.widget<SchedulePrimaryButton>(
          find.byKey(const Key('record-attendance')),
        );
        final confirm = tester.widget<SchedulePrimaryButton>(
          find.byKey(const Key('confirm-no-show')),
        );
        expect(record.onPressed, isNotNull);
        expect(record.light, isFalse);
        expect(record.background, ScheduleTokens.navy);
        expect(confirm.onPressed, isNotNull);
        expect(confirm.light, isTrue);
        expect(find.text('Attendance correction'), findsNothing);
        await shot(tester, '20-attendance-missing');
      },
    );

    testWidgets(
      'Confirm no-show asks first; Cancel sends nothing; Confirm shows the final state from the server, no success toast',
      (tester) async {
        final f = Fake(report(staff: [provisional()], ready: true))
          ..afterNoShow = () =>
              report(staff: [confirmedNoShow()], ready: true);
        await openReview(tester, f);
        await tester.tap(find.byKey(const Key('confirm-no-show')));
        await tester.pumpAndSettle();
        expect(
          find.text('Confirm that this staff member did not attend the shift?'),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const Key('confirm-no-show-cancel')));
        await tester.pumpAndSettle();
        expect(f.writes(), isEmpty);

        await tester.tap(find.byKey(const Key('confirm-no-show')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('confirm-no-show-confirm')));
        await tester.pump();
        expect(
          find.byKey(const ValueKey('schedule-toast-success')),
          findsNothing,
        );
        await tester.pumpAndSettle();
        expect(f.writes().map((w) => w.$2).toList(), [
          '/attendance/report/shift/shift-1/staff/staff-1/confirm-no-show',
        ]);
        expect(find.text('No-show · Confirmed'), findsOneWidget);
        expect(find.text('No-show confirmed'), findsOneWidget);
        expect(find.byKey(const Key('record-attendance')), findsNothing);
        expect(find.byKey(const Key('confirm-no-show')), findsNothing);
        expect(find.byKey(const Key('reopen-no-show')), findsOneWidget);
        await shot(tester, '21-no-show-confirmed');
      },
    );

    testWidgets(
      'a confirmed no-show is final: no actions once finalised; before that only Reopen (reason required)',
      (tester) async {
        final locked = Fake(
          report(
            staff: [confirmedNoShow()],
            ready: true,
            reportStatus: 'finalised',
            stage: 'finalised',
          ),
        );
        await openReview(tester, locked);
        expect(find.byKey(const Key('reopen-no-show')), findsNothing);
        expect(find.byKey(const Key('record-attendance')), findsNothing);
        expect(find.byKey(const Key('confirm-no-show')), findsNothing);

        final f = Fake(report(staff: [confirmedNoShow()], ready: true))
          ..afterReopen = () => report(staff: [provisional()], ready: true);
        await openReview(tester, f);
        await tester.tap(find.byKey(const Key('reopen-no-show')));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('reopen-no-show-reason')),
          'short',
        );
        await tester.tap(find.byKey(const Key('reopen-no-show-confirm')));
        await tester.pumpAndSettle();
        expect(
          find.text('Explain the reason in at least 10 characters.'),
          findsOneWidget,
        );
        expect(f.writes(), isEmpty);
        await tester.enterText(
          find.byKey(const Key('reopen-no-show-reason')),
          'Staff arrived late; bar manager confirmed.',
        );
        await tester.tap(find.byKey(const Key('reopen-no-show-confirm')));
        await tester.pumpAndSettle();
        final write = f.writes().single;
        expect(
          write.$2,
          '/attendance/report/shift/shift-1/staff/staff-1/reopen-no-show',
        );
        expect(write.$3, {
          'reason': 'Staff arrived late; bar manager confirmed.',
        });
        expect(find.text('Attendance missing · Needs review'), findsOneWidget);
        expect(find.byKey(const Key('record-attendance')), findsOneWidget);
      },
    );

    testWidgets(
      'Record attendance sheet: staff details, nothing pre-filled, inline validation and no request until valid',
      (tester) async {
        final f = Fake(report(staff: [provisional()], ready: true));
        await openReview(tester, f);
        await openSheet(tester);
        expect(
          find.descendant(
            of: find.byKey(const Key('entry-staff-details')),
            matching: find.text('Staff Test 1'),
          ),
          findsOneWidget,
        );
        expect(
          find.text('Venue Test 1 · Test Role 1'),
          findsWidgets,
        );
        expect(find.textContaining('Scheduled 15:45–22:45'), findsOneWidget);
        // Never pre-filled with the scheduled times.
        expect(find.text('Select date and time'), findsNWidgets(2));
        expect(find.textContaining('15:45 '), findsNothing);
        expect(find.byKey(const Key('entry-worked-value')), findsOneWidget);
        expect(
          tester.widget<Text>(find.byKey(const Key('entry-worked-value'))).data,
          '—',
        );

        await tapSave(tester);
        await tester.pumpAndSettle();
        expect(
          find.text('Select the actual clock-in date and time.'),
          findsOneWidget,
        );
        expect(
          find.text('Select the actual clock-out date and time.'),
          findsOneWidget,
        );
        expect(find.text('Select a reason.'), findsOneWidget);
        expect(f.writes(), isEmpty);
        await shot(tester, '22-record-attendance-validation');
      },
    );

    testWidgets(
      'Record attendance end to end: picked times, live preview, Other needs an explanation, loading state, the server report is shown with "Entered by manager"',
      (tester) async {
        var now = DateTime(2026, 10, 16, 16, 5);
        final f = Fake(report(staff: [provisional()], ready: true))
          ..recordDelay = const Duration(milliseconds: 400)
          ..afterRecord = () => report(staff: [recorded()], ready: true);
        await openReview(tester, f);
        final d = detail(f.reportJson);
        // Open the sheet directly with a fixed device clock so the pickers start at known values.
        final ctx = tester.element(find.byType(ReviewStaffReportScreen));
        final result = showAttendanceEntrySheet(
          ctx,
          report: d,
          row: d.staff.first,
          clock: () => now,
        );
        await tester.pumpAndSettle();
        await pickAt(tester, 'entry-clock-in'); // 16 Oct 16:05
        now = DateTime(2026, 10, 16, 22, 40);
        await pickAt(tester, 'entry-clock-out'); // 16 Oct 22:40
        expect(find.text('Fri 16 Oct 2026, 16:05'), findsOneWidget);
        expect(find.text('Fri 16 Oct 2026, 22:40'), findsOneWidget);
        // 395 min span − 30 min break (presentation only).
        expect(
          tester.widget<Text>(find.byKey(const Key('entry-worked-value'))).data,
          '6h 5m',
        );
        await tester.enterText(find.byKey(const Key('entry-break')), '45');
        await tester.pump();
        expect(
          tester.widget<Text>(find.byKey(const Key('entry-worked-value'))).data,
          '5h 50m',
        );
        await tester.enterText(find.byKey(const Key('entry-break')), '30');
        now = DateTime(2026, 10, 17, 9);
        await chooseReason(tester, 'Other');
        await tapSave(tester);
        await tester.pumpAndSettle();
        expect(
          find.text('Explain the reason in at least 10 characters.'),
          findsOneWidget,
        );
        expect(f.writes(), isEmpty);
        await tester.enterText(
          find.byKey(const Key('entry-note')),
          'Phone battery died at the start of the shift.',
        );
        await tapSave(tester);
        await tester.pump();
        expect(find.text('Please wait…'), findsOneWidget); // loading state
        await tester.pumpAndSettle();
        final saved = await result;
        expect(saved, isNotNull);
        final write = f.writes().single;
        expect(
          write.$2,
          '/attendance/report/shift/shift-1/staff/staff-1/record-attendance',
        );
        expect(write.$3, {
          'clockInAt': DateTime(2026, 10, 16, 16, 5).toUtc().toIso8601String(),
          'clockOutAt': DateTime(
            2026,
            10,
            16,
            22,
            40,
          ).toUtc().toIso8601String(),
          'breakMinutes': 30,
          'reasonCode': 'other',
          'reasonNote': 'Phone battery died at the start of the shift.',
        });
        expect(find.byType(AttendanceEntrySheet), findsNothing);
        expect(
          find.byKey(const ValueKey('schedule-toast-success')),
          findsNothing,
        );
      },
    );

    testWidgets(
      'after a saved entry the screen shows the SERVER values, "Entered by manager", and the review is still to do',
      (tester) async {
        final f = Fake(report(staff: [provisional()], ready: true))
          ..afterRecord = () => report(staff: [recorded()], ready: true);
        await openReview(tester, f);
        await openSheet(tester);
        // Close without saving: nothing changes.
        await tester.ensureVisible(find.byKey(const Key('cancel-attendance')));
        await tester.tap(find.byKey(const Key('cancel-attendance')));
        await tester.pumpAndSettle();
        expect(f.writes(), isEmpty);
        expect(find.text('Attendance missing · Needs review'), findsOneWidget);

        // The server applied an entry (e.g. on another device): the reloaded seat renders it.
        f.reportJson = report(staff: [recorded()], ready: true);
        await openReview(tester, f);
        expect(find.byKey(const Key('manager-entered')), findsOneWidget);
        expect(find.text('Entered by manager'), findsOneWidget);
        expect(find.text('Corrected · Awaiting review'), findsOneWidget);
        final card = find.byKey(const Key('recorded-attendance'));
        expect(
          find.descendant(of: card, matching: find.text('16:05')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: card, matching: find.text('22:40')),
          findsOneWidget,
        );
        expect(find.byKey(const Key('record-attendance')), findsNothing);
        expect(find.byKey(const Key('confirm-no-show')), findsNothing);
        expect(enabled(tester, 'mark-attendance-reviewed'), isTrue);
        await shot(tester, '23-recorded-entered-by-manager');
      },
    );

    testWidgets(
      'a server rejection is an error toast titled "Invalid attendance times"; the sheet stays open with the values',
      (tester) async {
        var now = DateTime(2026, 10, 16, 16, 5);
        final f = Fake(report(staff: [provisional()], ready: true))
          ..rejectRecord = (
            400,
            {
              'statusCode': 400,
              'code': 'INVALID_ATTENDANCE_TIMES',
              'message':
                  'The clock-out time cannot be more than 120 minutes after the scheduled end.',
            },
          );
        await openReview(tester, f);
        final d = detail(f.reportJson);
        final ctx = tester.element(find.byType(ReviewStaffReportScreen));
        showAttendanceEntrySheet(
          ctx,
          report: d,
          row: d.staff.first,
          clock: () => now,
        );
        await tester.pumpAndSettle();
        await pickAt(tester, 'entry-clock-in');
        now = DateTime(2026, 10, 16, 22, 40);
        await pickAt(tester, 'entry-clock-out');
        now = DateTime(2026, 10, 17, 9);
        await chooseReason(tester, 'Mobile application issue');
        await tapSave(tester);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        final toast = find.byKey(const ValueKey('schedule-toast-error'));
        expect(toast, findsOneWidget);
        expect(
          find.descendant(
            of: toast,
            matching: find.text('Invalid attendance times'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: toast,
            matching: find.text(
              'The clock-out time cannot be more than 120 minutes after the scheduled end.',
            ),
          ),
          findsOneWidget,
        );
        await tester.pumpAndSettle();
        expect(find.byType(AttendanceEntrySheet), findsOneWidget);
        expect(find.text('Fri 16 Oct 2026, 22:40'), findsOneWidget);
        expect(find.byType(SnackBar), findsNothing);
      },
    );

    testWidgets(
      'partial attendance (clock-out missing) keeps the recorded clock-in and never offers Confirm no-show',
      (tester) async {
        final f = Fake(report(staff: [row(inAt: clockIn)]));
        await openReview(tester, f);
        expect(find.text('16:00'), findsOneWidget);
        expect(find.text('Clock-out time is missing'), findsOneWidget);
        expect(find.byKey(const Key('confirm-no-show')), findsNothing);
        expect(find.byKey(const Key('record-attendance')), findsNothing);
        expect(find.byKey(const Key('save-review-screen')), findsOneWidget);
      },
    );

    testWidgets(
      '320dp at 2x text: both bottom actions stay visible inside the safe area; the sheet lays out without overflow',
      (tester) async {
        tester.view.padding = const FakeViewPadding(bottom: 48);
        final f = Fake(report(staff: [provisional()], ready: true));
        await openReview(
          tester,
          f,
          size: const Size(640, 1280),
          ratio: 2,
          textScale: 2,
        );
        expect(tester.takeException(), isNull);
        final screenHeight = 1280 / 2;
        for (final key in ['record-attendance', 'confirm-no-show']) {
          final rect = tester.getRect(find.byKey(Key(key)));
          expect(rect.bottom, lessThanOrEqualTo(screenHeight - 24));
          expect(rect.left, greaterThanOrEqualTo(0));
          expect(rect.right, lessThanOrEqualTo(320));
        }
        await shot(tester, '24-small-screen-missing');
        await openSheet(tester);
        expect(tester.takeException(), isNull);
        await tester.ensureVisible(find.byKey(const Key('save-attendance')));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await shot(tester, '25-small-screen-sheet');
      },
    );

    testWidgets(
      'the Staff review tab is unaffected for a seat with missing attendance',
      (tester) async {
        final f = Fake(report(staff: [provisional()], ready: true));
        final d = detail(f.reportJson);
        await mount(
          tester,
          f,
          ReviewStaffReportScreen(
            report: d,
            row: d.staff.first,
            initialReview: true,
          ),
        );
        expect(find.text('Staff performance'), findsOneWidget);
        expect(find.byKey(const Key('save-performance-review')), findsOneWidget);
        expect(find.byKey(const Key('record-attendance')), findsNothing);
        expect(find.byKey(const Key('confirm-no-show')), findsNothing);
      },
    );
  });

  group('Staff review', () {
    testWidgets(
      'every area must be rated (no defaults); the saved review is sent once with the chosen values',
      (tester) async {
        final json = report(
          staff: [row(inAt: clockIn, outAt: end, status: 'clocked_out')],
        );
        final f = Fake(json);
        final d = detail(json);
        await mount(
          tester,
          f,
          ReviewStaffReportScreen(
            report: d,
            row: d.staff.first,
            initialReview: true,
          ),
        );
        expect(find.text('Staff performance'), findsOneWidget);
        await tester.tap(find.byKey(const Key('rating-grooming-4')));
        await tester.pump();
        await tester.tap(find.text('Save review'));
        await tester.pumpAndSettle();
        expect(
          find.textContaining('Rate every area before saving'),
          findsOneWidget,
        );
        expect(f.writes(), isEmpty);
        for (final (key, v) in [
          ('attitude', 3),
          ('skills', 5),
          ('attendance', 5),
          ('timeKeeping', 5),
        ]) {
          await tester.tap(find.byKey(Key('rating-$key-$v')));
        }
        await tester.enterText(
          find.byKey(const Key('review-feedback')),
          'Great shift',
        );
        await tester.tap(find.text('Save review'));
        await tester.pumpAndSettle();
        final write = f.writes().single;
        expect(write.$1, 'PUT');
        expect(write.$2, '/attendance/report/shift/shift-1/reviews/staff-1');
        expect(write.$3, {
          'grooming': 4,
          'attitude': 3,
          'skills': 5,
          'attendance': 5,
          'timeKeeping': 5,
          'feedback': 'Great shift',
        });
      },
    );

    testWidgets('a finalised report shows the saved review read-only', (
      tester,
    ) async {
      final json = report(
        staff: [
          row(inAt: clockIn, outAt: end, status: 'approved', reviewed: true),
        ],
        reportStatus: 'finalised',
      );
      final f = Fake(json)
        ..reviewEditable = false
        ..review = {
          'grooming': 4,
          'attitude': 3,
          'skills': 5,
          'attendance': 5,
          'timeKeeping': 5,
          'feedback': null,
          'reviewerName': 'Venue Test',
        };
      final d = detail(json);
      await mount(
        tester,
        f,
        ReviewStaffReportScreen(
          report: d,
          row: d.staff.first,
          initialReview: true,
        ),
      );
      expect(find.text('Report finalised'), findsOneWidget);
      await tester.tap(find.byKey(const Key('rating-grooming-1')));
      await tester.pump();
      expect(enabled(tester, 'save-performance-review'), isFalse);
      expect(f.writes(), isEmpty);
    });
  });

  group('Footer (server actions)', () {
    Future<void> expectFooter(
      WidgetTester tester, {
      required bool timesheet,
      required bool finalise,
    }) async {
      expect(
        find.byKey(const Key('open-timesheet')),
        timesheet ? findsOneWidget : findsNothing,
      );
      expect(
        find.byKey(const Key('finalise-and-send')),
        finalise ? findsOneWidget : findsNothing,
      );
    }

    testWidgets('before the 3-hour window: no Time-sheet and no Finalise', (
      tester,
    ) async {
      final f = Fake(
        report(
          staff: [row(attendanceId: null, status: null)],
          displayStatus: 'waiting_clock_in',
          stage: 'scheduled',
        ),
      );
      await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
      await expectFooter(tester, timesheet: false, finalise: false);
    });

    testWidgets(
      'pre-shift window: exactly one Time-sheet button, never Finalise',
      (tester) async {
        final f = Fake(
          report(
            staff: [row(attendanceId: null, status: null)],
            displayStatus: 'waiting_clock_in',
            stage: 'pre_shift',
          ),
        );
        await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
        await expectFooter(tester, timesheet: true, finalise: false);
      },
    );

    testWidgets(
      'after the start: two equal buttons; Time-sheet stays usable while Finalise is disabled',
      (tester) async {
        final f = Fake(report(staff: [row(inAt: clockIn)]));
        await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
        await expectFooter(tester, timesheet: true, finalise: true);
        final a = tester.getSize(find.byKey(const Key('open-timesheet')));
        final b = tester.getSize(find.byKey(const Key('finalise-and-send')));
        expect(a, b);
        expect(
          tester.getTopLeft(find.byKey(const Key('open-timesheet'))).dy,
          tester.getTopLeft(find.byKey(const Key('finalise-and-send'))).dy,
        );
        expect(enabled(tester, 'open-timesheet'), isTrue);
        expect(enabled(tester, 'finalise-and-send'), isFalse);
        expect(
          find.text('Time-sheet'),
          findsOneWidget,
        ); // no duplicate footer anywhere
        expect(find.text('Finalise & send'), findsOneWidget);
      },
    );

    testWidgets('finalised: one Time-sheet button and no second finalisation', (
      tester,
    ) async {
      final f = Fake(
        report(
          staff: [row(inAt: clockIn, outAt: end, status: 'approved')],
          reportStatus: 'finalised',
          stage: 'finalised',
          ready: true,
        ),
      );
      await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
      await expectFooter(tester, timesheet: true, finalise: false);
    });

    testWidgets(
      'Finalise & send opens the sign-off; Sign & send needs breaks + a typed name, then sends once and reloads',
      (tester) async {
        final f = Fake(
          report(
            staff: [
              row(
                inAt: clockIn,
                outAt: end,
                status: 'clocked_out',
                reviewed: true,
              ),
            ],
            displayStatus: 'ready_to_finalise',
            ready: true,
          ),
        );
        await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
        await tester.tap(find.byKey(const Key('finalise-and-send')));
        await tester.pumpAndSettle();
        expect(find.text('Sign off the timesheet'), findsOneWidget);
        expect(enabled(tester, 'sign-and-send'), isFalse);
        await tester.enterText(
          find.byKey(const Key('signature-name')),
          'Venue Test',
        );
        await tester.pump();
        expect(enabled(tester, 'sign-and-send'), isFalse);
        await tester.tap(find.byKey(const Key('confirm-breaks')));
        await tester.pump();
        expect(enabled(tester, 'sign-and-send'), isTrue);
        await tester.tap(find.byKey(const Key('sign-and-send')));
        await tester.pumpAndSettle();
        final write = f.writes().single;
        expect(write.$1, 'PATCH');
        expect(write.$3, {
          'signedOffName': 'Venue Test',
          'breakConfirmed': true,
        });
        expect(find.text('Sign off the timesheet'), findsNothing);
      },
    );

    testWidgets('one tap opens exactly one document screen', (tester) async {
      final f = Fake(report(staff: [row(inAt: clockIn)]));
      await mount(tester, f, const ShiftReportScreen(shiftId: 'shift-1'));
      await tester.tap(find.byKey(const Key('open-timesheet')));
      await tester.pumpAndSettle();
      expect(find.byType(ReportDocumentScreen), findsOneWidget);
    });
  });

  group('Document viewer and download', () {
    final saver = _FakeSaver();
    Widget doc({bool preShift = false}) => ReportDocumentScreen(
      shiftId: 'shift-1',
      showPreShift: preShift,
      viewer: (bytes) =>
          Text('PDF ${bytes.length} bytes', key: const Key('fake-pdf')),
      saver: saver,
    );
    setUp(() => saver.saved.clear());

    testWidgets(
      'shift attendance sheet: real bytes from the authorised download, previewed, and Download saves the actual PDF',
      (tester) async {
        final f = Fake(
          report(
            staff: [row(attendanceId: null, status: null)],
            displayStatus: 'waiting_clock_in',
            stage: 'pre_shift',
          ),
        );
        await mount(tester, f, doc());
        expect(find.text('Shift attendance sheet'), findsOneWidget);
        expect(
          find.text('Before shift · QR clock-in / out included'),
          findsOneWidget,
        );
        expect(find.byKey(const Key('fake-pdf')), findsOneWidget);
        expect(f.requests.map((r) => r.$2), contains('/files/f-pre/download'));
        await tester.tap(find.byKey(const Key('download-pdf')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(saver.saved.single.$2, 'shift-attendance-sheet.pdf');
        expect(String.fromCharCodes(saver.saved.single.$1.take(5)), '%PDF-');
        // Owner decision: no success toast in the mobile app.
        expect(
          find.byKey(const ValueKey('schedule-toast-success')),
          findsNothing,
        );
        await tester.pumpAndSettle();
      },
    );

    testWidgets(
      'the worker has not stored it yet: Preparing with Retry, never a broken PDF',
      (tester) async {
        final f = Fake(
          report(
            staff: [],
            displayStatus: 'waiting_clock_in',
            stage: 'pre_shift',
            timesheetReady: false,
          ),
        );
        await mount(tester, f, doc());
        expect(find.text('Preparing your time-sheet'), findsOneWidget);
        expect(find.byKey(const Key('document-retry')), findsOneWidget);
        expect(find.byKey(const Key('download-pdf')), findsNothing);
      },
    );

    testWidgets(
      'a missing stored object is reported, not faked, and Retry recovers once it exists',
      (tester) async {
        final f = Fake(
          report(
            staff: [],
            displayStatus: 'waiting_clock_in',
            stage: 'pre_shift',
          ),
        )..storageMissing = true;
        await mount(tester, f, doc());
        expect(find.text('Document unavailable'), findsOneWidget);
        expect(
          find.textContaining('could not be found in storage'),
          findsOneWidget,
        );
        f.storageMissing = false;
        await tester.tap(find.byKey(const Key('document-retry')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('fake-pdf')), findsOneWidget);
      },
    );

    testWidgets('a non-PDF payload is refused', (tester) async {
      final f = Fake(
        report(
          staff: [],
          displayStatus: 'waiting_clock_in',
          stage: 'pre_shift',
        ),
      )..notPdf = true;
      await mount(tester, f, doc());
      expect(find.text('Document unavailable'), findsOneWidget);
      expect(find.byKey(const Key('fake-pdf')), findsNothing);
    });

    testWidgets(
      'finalised, final PDF still generating: the earlier sheet is shown and labelled, never called final',
      (tester) async {
        final f = Fake(
          report(
            staff: [],
            reportStatus: 'finalised',
            stage: 'finalised',
            deliveryState: 'generating',
          ),
        );
        await mount(tester, f, doc());
        expect(find.text('Shift attendance sheet'), findsOneWidget);
        expect(find.text('Final timesheet'), findsNothing);
        expect(find.text('Generating PDF'), findsOneWidget);
      },
    );

    testWidgets(
      'final timesheet ready: opened by default with its real delivery state and a link to the earlier sheet',
      (tester) async {
        final f = Fake(
          report(
            staff: [],
            reportStatus: 'finalised',
            stage: 'finalised',
            deliveryState: 'sent',
            finalReady: true,
          ),
        );
        await mount(tester, f, doc());
        expect(find.text('Final timesheet'), findsOneWidget);
        expect(
          find.text('After shift · recorded hours and feedback'),
          findsOneWidget,
        );
        expect(find.text('Sent'), findsOneWidget);
        expect(
          f.requests.map((r) => r.$2),
          contains('/files/f-final/download'),
        );
        expect(find.byKey(const Key('open-pre-shift')), findsOneWidget);
      },
    );

    test(
      'a presigned storage redirect is followed WITHOUT the bearer token; the token never goes into a URL',
      () async {
        final seen = <http.BaseRequest>[];
        final api = ApiClient(
          httpClient: MockClient.streaming((req, _) async {
            seen.add(req);
            if (req.url.path.endsWith('/download')) {
              return http.StreamedResponse(
                const Stream.empty(),
                302,
                headers: {
                  'location':
                      'https://storage.example.test/obj?X-Amz-Signature=abc',
                },
              );
            }
            return http.StreamedResponse(
              Stream.value('%PDF-1.4 x'.codeUnits),
              200,
              headers: {'content-type': 'application/pdf'},
            );
          }),
        );
        await api.storeTokens('access-token', 'refresh-token');
        final file = await api.downloadFile('/files/f-1/download');
        expect(file.isPdf, isTrue);
        expect(seen, hasLength(2));
        expect(seen[0].headers['Authorization'], 'Bearer access-token');
        expect((seen[0] as http.Request).followRedirects, isFalse);
        expect(seen[1].url.host, 'storage.example.test');
        expect(seen[1].headers.containsKey('Authorization'), isFalse);
        expect(
          seen.any((r) => r.url.toString().contains('access-token')),
          isFalse,
        );
      },
    );

    test(
      'an expired session that cannot refresh surfaces 401 instead of a fake success',
      () async {
        final api = ApiClient(
          httpClient: MockClient(
            (req) async => http.Response('{"message":"Unauthorized"}', 401),
          ),
        );
        await api.storeTokens('access-token', 'refresh-token');
        await expectLater(
          api.downloadFile('/files/f-1/download'),
          throwsA(
            isA<ApiException>().having((e) => e.statusCode, 'status', 401),
          ),
        );
      },
    );
  });
}

bool enabled(WidgetTester tester, String key) =>
    tester
        .widget<TextButton>(
          find.descendant(
            of: find.byKey(Key(key)),
            matching: find.byType(TextButton),
          ),
        )
        .onPressed !=
    null;

/// The resolved background of the Finalise & send button (dark navy when enabled, light grey when disabled).
Color? finaliseColor(WidgetTester tester) => tester
    .widget<TextButton>(
      find.descendant(
        of: find.byKey(const Key('finalise-and-send')),
        matching: find.byType(TextButton),
      ),
    )
    .style!
    .backgroundColor!
    .resolve(<WidgetState>{});

class _FakeSaver implements DocumentSaver {
  final saved = <(List<int>, String)>[];
  @override
  Future<String> save(Uint8List bytes, String filename) async {
    saved.add((bytes, filename));
    return 'Saved $filename';
  }
}
