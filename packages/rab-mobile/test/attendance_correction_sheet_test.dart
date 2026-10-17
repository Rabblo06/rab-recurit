import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/features/venue_manager/attendance_correction_sheet.dart';
import 'package:rab_staff/features/venue_manager/shift_report.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';

final clockIn = DateTime(2026, 10, 16, 16, 0);

ShiftReportStaffRow row({required DateTime clockOut}) =>
    ShiftReportStaffRow.fromJson({
      'staffProfileId': 'staff-1',
      'staffName': 'Staff Test 1',
      'roleName': 'Waiter',
      'assignmentStatus': 'completed',
      'attendanceId': 'att-1',
      'attendanceStatus': 'clocked_out',
      'clockInAt': clockIn.toUtc().toIso8601String(),
      'clockOutAt': clockOut.toUtc().toIso8601String(),
      'breakMinutes': 0,
      'scheduledBreakMinutes': 0,
    });

Future<List<Map<String, dynamic>>> openSheet(
  WidgetTester tester,
  ShiftReportStaffRow r,
) async {
  final posted = <Map<String, dynamic>>[];
  final api = ApiClient(
    httpClient: MockClient((req) async {
      posted.add(jsonDecode(req.body) as Map<String, dynamic>);
      return http.Response('{}', 200);
    }),
  );
  tester.view.physicalSize = const Size(800, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ChangeNotifierProvider(
      create: (_) => VenueManagerProvider(api, 'user-1'),
      child: MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showAttendanceCorrectionSheet(
                context,
                row: r,
                shiftDate: clockIn,
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Clock out'));
  await tester.pumpAndSettle();
  return posted;
}

Future<void> pickDay(WidgetTester tester, String day) async {
  await tester.tap(find.byKey(const Key('correction-date')));
  await tester.pumpAndSettle();
  await tester.tap(find.text(day));
  await tester.tap(find.text('OK'));
  await tester.pumpAndSettle();
}

Future<void> save(WidgetTester tester) async {
  await tester.enterText(
    find.widgetWithText(TextField, 'Reason (required)'),
    'staff has missed the clock out',
  );
  await tester.ensureVisible(find.text('Save correction'));
  await tester.tap(find.text('Save correction'));
  await tester.pumpAndSettle();
}

void main() {
  // ApiClient reads its token from secure storage, a platform channel tests don't have.
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('an overnight clock-out is saved on the chosen next day, '
      'not on the shift start date', (tester) async {
    final posted = await openSheet(
      tester,
      row(clockOut: DateTime(2026, 10, 16, 23, 0)),
    );
    expect(find.text('Fri 16 Oct'), findsOneWidget);
    await pickDay(tester, '17');
    expect(
      find.text('Clock out will be saved as Sat 17 Oct 2026, 23:00'),
      findsOneWidget,
    );
    await save(tester);
    expect(posted.single['field'], 'clockOutAt');
    expect(
      posted.single['newValue'],
      DateTime(2026, 10, 17, 23, 0).toUtc().toIso8601String(),
    );
  });

  testWidgets('an existing next-day clock-out opens on its own date', (
    tester,
  ) async {
    await openSheet(tester, row(clockOut: DateTime(2026, 10, 17, 3, 15)));
    expect(find.text('Sat 17 Oct'), findsOneWidget);
    expect(
      find.text('Clock out will be saved as Sat 17 Oct 2026, 03:15'),
      findsOneWidget,
    );
  });

  testWidgets('a clock-out before clock-in is explained and never sent', (
    tester,
  ) async {
    final posted = await openSheet(
      tester,
      row(clockOut: DateTime(2026, 10, 17, 3, 15)),
    );
    await pickDay(tester, '16');
    await save(tester);
    expect(find.textContaining('This is before clock in'), findsOneWidget);
    expect(find.textContaining('change the date'), findsOneWidget);
    expect(posted, isEmpty);
  });
}
