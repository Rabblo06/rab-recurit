import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/models/attendance.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/theme/money.dart';
import 'package:rab_staff/core/theme/schedule_tokens.dart';
import 'package:rab_staff/core/theme/shift_visual_style.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/schedule_feedback.dart';
import 'package:rab_staff/core/widgets/venue_photo.dart';
import 'package:rab_staff/features/history/staff_history.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/home/home_dashboard_data.dart';
import 'package:rab_staff/features/home/schedule_clock_screen.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/features/offers/staff_shift_lifecycle.dart';
import 'package:rab_staff/features/payslips/payslips_screen.dart';
import 'support/biometric_test_support.dart';

final _now = DateTime.utc(2026, 10, 20, 21);

OfferSummary _offer(
  String shiftId, {
  String status = 'manager_confirmed',
  String? state,
  Duration startIn = const Duration(hours: 2),
  int rate = 1242,
  String? photo,
}) {
  final start = _now.add(startIn);
  return OfferSummary(
    id: 'offer-$shiftId',
    status: status,
    sentAt: _now,
    expiresAt: _now,
    estimatedPayPence: rate * 3,
    shiftId: shiftId,
    startsAt: start,
    endsAt: start.add(const Duration(hours: 3)),
    venueName: 'Venue $shiftId',
    roleName: 'Role $shiftId',
    staffProfileId: 'staff',
    staffName: 'Staff Member',
    payRatePence: rate,
    venuePhotoFileId: photo,
    presentation: state == null
        ? null
        : StaffShiftPresentation.fromJson({
            'state': state,
            'homeLabel': 'Next Shift',
            'isToday': false,
            'serverNow': _now.toIso8601String(),
          }),
  );
}

AttendanceSummary _attendance(
  String shiftId,
  String status, {
  int? worked,
  DateTime? start,
  bool clockedOut = true,
  String? payroll,
  int? approvedPence,
}) {
  final s = start ?? _now.subtract(const Duration(days: 1));
  return AttendanceSummary(
    id: 'att-$shiftId',
    status: status,
    clockInAt: s,
    clockOutAt: clockedOut ? s.add(const Duration(hours: 3)) : null,
    workedMinutes: worked,
    earnedPence: worked == null ? null : worked * 20,
    shiftId: shiftId,
    startsAt: s,
    endsAt: s.add(const Duration(hours: 3)),
    venueName: 'Venue $shiftId',
    roleName: 'Role $shiftId',
    staffProfileId: 'staff',
    staffName: 'Staff Member',
    payrollStatus: payroll,
    payrollApprovedPence: approvedPence,
  );
}

void main() {
  group('shift colour identity', () {
    test('palette is the three approved pastels in reference order', () {
      expect(ShiftVisualStyle.palette, [
        ShiftVisualStyle.mint,
        ShiftVisualStyle.peach,
        ShiftVisualStyle.lavender,
      ]);
      expect(ShiftVisualStyle.mint.card, const Color(0xFFECFCF5));
      expect(ShiftVisualStyle.peach.card, const Color(0xFFFFF2E9));
      expect(ShiftVisualStyle.lavender.card, const Color(0xFFDFE2FF));
    });

    test('a shift keeps its colour across list order changes', () {
      final registry = ShiftColourRegistry()..registerGroup(['a', 'b', 'c']);
      final before = {
        for (final id in ['a', 'b', 'c']) id: registry.resolve(id),
      };
      registry.registerGroup(['c', 'b', 'a', 'd']);
      for (final entry in before.entries) {
        expect(registry.resolve(entry.key), entry.value);
      }
    });

    test('saved colours survive a restart and never store the shift id', () {
      final saved = <String, int>{};
      final first = ShiftColourRegistry()
        ..onAssigned = (key, slot) => saved[key] = slot;
      const ids = ['3f1c-shift-a', '9a2b-shift-b', '77de-shift-c'];
      first.registerGroup(ids);
      final colours = ids.map(first.resolve).toList();
      expect(saved.keys.any((key) => ids.any(key.contains)), isFalse);

      // A new process discovers the shifts in a different order.
      final restarted = ShiftColourRegistry()..restore(saved);
      restarted.registerGroup(ids.reversed);
      expect(ids.map(restarted.resolve).toList(), colours);
    });

    test('out-of-range saved slots are ignored', () {
      final registry = ShiftColourRegistry()
        ..restore({ShiftColourRegistry.persistenceKey('x'): 9});
      expect(ShiftVisualStyle.palette, contains(registry.resolve('x')));
    });
  });

  group('Confirmed lifecycle', () {
    test('keeps upcoming and live shifts, drops finished ones', () {
      final rows = currentConfirmedShifts([
        _offer('future', state: 'confirmed'),
        _offer(
          'live-overrun',
          state: 'live',
          startIn: const Duration(hours: -5),
        ),
        _offer('clocked-out', state: 'clockedOut'),
        _offer('complete', state: 'complete'),
        _offer('ended-no-attendance', state: 'ended'),
        _offer('pending', status: 'pending', state: 'pending'),
      ], now: _now);
      expect(rows.map((o) => o.shiftId), ['live-overrun', 'future']);
    });

    test('Home confirmed count agrees with the Confirmed page', () {
      final offers = [
        _offer('a', state: 'confirmed'),
        _offer('b', state: 'complete'),
        _offer('c', state: 'ended'),
      ];
      expect(HomeDashboardData(offers, now: _now).confirmed, 1);
    });
  });

  group('History (payroll-approved only)', () {
    final rows = buildStaffHistory(
      history: [
        // 1. Clocked out, payroll pending.
        _attendance('clocked-out', 'clocked_out', worked: 180),
        // 2. Timesheet signed (report finalised), payroll pending.
        _attendance(
          'signed',
          'approved',
          worked: 180,
          payroll: 'pending_approval',
        ),
        // 3. Payroll approved.
        _attendance(
          'approved',
          'approved',
          worked: 240,
          start: _now,
          payroll: 'approved',
          approvedPence: 5600,
        ),
        // 4. Payroll rejected.
        _attendance('rejected', 'approved', worked: 120, payroll: 'rejected'),
        _attendance('missing', 'missing_clock_out', clockedOut: false),
        _attendance(
          'paid',
          'approved',
          worked: 60,
          start: _now,
          payroll: 'paid',
          approvedPence: 1400,
        ),
        _attendance(
          'post-approval-dispute',
          'disputed',
          worked: 60,
          payroll: 'approved',
          approvedPence: 1400,
        ),
      ],
      offers: [
        _offer('no-show', state: 'ended'),
        _offer('upcoming', state: 'confirmed'),
      ],
    );
    Iterable<String> ids() => rows.map((r) => r.shiftId);

    test('only payroll-approved shifts appear', () {
      expect(ids().toSet(), {'approved', 'paid', 'post-approval-dispute'});
    });

    test('clock-out, signed timesheet and rejected payroll stay out', () {
      expect(ids(), isNot(contains('clocked-out')));
      expect(ids(), isNot(contains('signed')));
      expect(ids(), isNot(contains('rejected')));
      expect(ids(), isNot(contains('missing')));
    });

    test('offers never create History rows (no-show, upcoming)', () {
      expect(ids(), isNot(contains('no-show')));
      expect(ids(), isNot(contains('upcoming')));
    });

    test('approved shift shows verified hours and approved pay', () {
      final row = rows.singleWhere((r) => r.shiftId == 'approved');
      expect(row.badge, 'Completed');
      expect(row.attendance.workedMinutes, 240);
      expect(row.attendance.payrollApprovedPence, 5600);
    });

    test('approving one shift does not expose another pending shift', () {
      final one = buildStaffHistory(
        history: [
          _attendance('a', 'approved', payroll: 'approved', approvedPence: 1),
          _attendance('b', 'approved', payroll: 'pending_approval'),
        ],
        offers: const [],
      );
      expect(one.map((r) => r.shiftId), ['a']);
    });

    test('a correction after approval is the only Needs attention row', () {
      final attention = rows.where(
        (r) => r.matches(HistoryFilter.needsAttention),
      );
      expect(attention.map((r) => r.shiftId), ['post-approval-dispute']);
      expect(rows.where((r) => r.matches(HistoryFilter.completed)).length, 2);
    });

    test('verified hours count approved payroll in this month only', () {
      expect(verifiedMinutesThisMonth(rows, _now), 360);
    });

    test('a revoked approval leaves History on the next load', () {
      final revoked = buildStaffHistory(
        history: [_attendance('approved', 'approved', payroll: 'corrected')],
        offers: const [],
      );
      expect(revoked, isEmpty);
    });
  });

  test('a zero pay rate reads as not set, never as £0.00/h', () {
    expect(payRateLabel(0), 'Rate not set');
    expect(payRateLabel(1242), '£12.42/h');
    expect(estimatedPayLabel(0, 0), 'Estimated pay unavailable');
  });

  group('widgets', () {
    tearDown(clearSecureStorageChannel);

    Future<void> mountClock(WidgetTester tester) async {
      stubSecureStorageChannel({
        'rab.accessToken': 'test-access',
        'rab.refreshToken': 'test-refresh',
      });
      tester.view.physicalSize = const Size(393, 852);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var clockCalls = 0;
      final api = ApiClient(
        httpClient: MockClient((request) async {
          final path = request.url.path;
          if (path.contains('/attendance/clock')) clockCalls++;
          if (path.endsWith('/attendance/me/active')) {
            return http.Response(
              jsonEncode({
                'attendance': null,
                'serverNow': _now.toIso8601String(),
                'clockInEarlyMinutes': 15,
              }),
              200,
            );
          }
          return http.Response('[]', 200);
        }),
      );
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider(create: (_) => OffersProvider(api)),
            ChangeNotifierProvider(create: (_) => AttendanceProvider(api)),
          ],
          child: MaterialApp(
            theme: buildLightTheme(),
            home: const ScheduleClockScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      addTearDown(() => expect(clockCalls, 0));
    }

    testWidgets('no shift shows a centred, disabled "No Shift" action', (
      tester,
    ) async {
      await mountClock(tester);
      final action = find.byKey(const ValueKey('clock-no-shift'));
      expect(action, findsOneWidget);
      expect(find.text('No Shift'), findsWidgets);
      expect(find.text('No shift today'), findsNothing);
      final button = tester.widget<FilledButton>(
        find.descendant(of: action, matching: find.byType(FilledButton)),
      );
      expect(button.onPressed, isNull);
      await tester.tap(action, warnIfMissed: false);
      await tester.pumpAndSettle();

      final rect = tester.getRect(action);
      final width = tester.view.physicalSize.width;
      expect(rect.left, moreOrLessEquals(width - rect.right, epsilon: 1));
      expect(rect.height, greaterThanOrEqualTo(ScheduleTokens.actionHeight));
      final label = tester.getRect(
        find.descendant(of: action, matching: find.text('No Shift')),
      );
      expect(label.center.dx, moreOrLessEquals(rect.center.dx, epsilon: 1));
    });

    testWidgets('bottom action keeps equal side margins', (tester) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: ScheduleBottomAction(
                child: SchedulePrimaryButton(
                  label: 'Clock in',
                  onPressed: () {},
                ),
              ),
            ),
          ),
        ),
      );
      final rect = tester.getRect(find.byType(FilledButton));
      expect(rect.left, ScheduleTokens.actionInset);
      expect(360 - rect.right, ScheduleTokens.actionInset);
      expect(rect.height, ScheduleTokens.actionHeight);
      expect(
        tester.getSemantics(find.byType(FilledButton)),
        matchesSemantics(
          label: 'Clock in',
          isButton: true,
          hasEnabledState: true,
          isEnabled: true,
          isFocusable: true,
          hasTapAction: true,
          hasFocusAction: true,
        ),
      );
    });

    ApiClient statementsApi(
      List<Map<String, dynamic>> rows, {
      List<Map<String, dynamic>> payslips = const [],
    }) => ApiClient(
      httpClient: MockClient((request) async {
        if (request.url.path.endsWith('/payroll/me/statements')) {
          return http.Response(
            jsonEncode({'total': rows.length, 'data': rows}),
            200,
          );
        }
        if (request.url.path.endsWith('/payroll/me/payslips')) {
          return http.Response(
            jsonEncode({
              'data': payslips,
              'unallocated': {'shiftCount': 0, 'grossPence': 0},
            }),
            200,
          );
        }
        return http.Response('{}', 404);
      }),
    );

    testWidgets('an uploaded payslip is available, not paid', (tester) async {
      stubSecureStorageChannel({'rab.accessToken': 'test-access'});
      await tester.pumpWidget(
        MaterialApp(
          home: PayslipsScreen(
            api: statementsApi(
              [],
              payslips: [
                {
                  'payslipId': 'ps-1',
                  'runId': 'run-1',
                  'period': {
                    'id': 'p',
                    'start': '2026-10-12',
                    'end': '2026-10-25',
                  },
                  'payday': '2026-11-04',
                  'status': 'available',
                  'shiftCount': 3,
                  'grossPence': 21000,
                  'netPence': 19620,
                  'netSource': 'provider_document',
                  'document': {
                    'fileId': 'f-1',
                    'filename': 'payslip.pdf',
                    'version': 1,
                    'uploadedAt': '2026-11-02T10:00:00Z',
                  },
                  'paidAt': null,
                },
                {
                  'payslipId': null,
                  'runId': null,
                  'period': {
                    'id': 'q',
                    'start': '2026-10-26',
                    'end': '2026-11-08',
                  },
                  'payday': '2026-11-18',
                  'status': 'upcoming',
                  'shiftCount': 1,
                  'grossPence': 5600,
                  'netPence': null,
                  'netSource': null,
                  'document': null,
                  'paidAt': null,
                },
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Latest payslip'), findsOneWidget);
      expect(find.text('£196.20'), findsNWidgets(2));
      expect(find.text('12 – 25 Oct 2026'), findsNWidgets(2));
      expect(find.text('Paid'), findsNothing);
      expect(find.text('Upcoming · payday 18 Nov'), findsOneWidget);
      expect(find.text('Not available yet'), findsOneWidget);
    });

    testWidgets('payslips show truthful empty states', (tester) async {
      stubSecureStorageChannel({'rab.accessToken': 'test-access'});
      await tester.pumpWidget(
        MaterialApp(home: PayslipsScreen(api: statementsApi([]))),
      );
      await tester.pumpAndSettle();
      expect(find.text('No official payslips available yet'), findsOneWidget);
      expect(find.text('No approved shift statements yet'), findsOneWidget);
      expect(find.textContaining('£'), findsNothing);
      expect(find.text('Paid'), findsNothing);
    });

    testWidgets('approved statement is never shown as paid', (tester) async {
      stubSecureStorageChannel({'rab.accessToken': 'test-access'});
      await tester.pumpWidget(
        MaterialApp(
          home: PayslipsScreen(
            api: statementsApi([
              {
                'payrollRecordId': 'pr-1',
                'status': 'approved',
                'attendanceId': 'att-1',
                'shiftId': 'shift-1',
                'venueName': 'Venue Test 1',
                'roleName': 'Test Role 1',
                'startsAt': '2026-10-20T19:45:00Z',
                'endsAt': '2026-10-20T22:45:00Z',
                'workedMinutes': 116,
                'payRatePence': 1200,
                'amountPence': 2320,
                'approvedAt': '2026-10-21T09:00:00Z',
                'payrollPeriod': null,
                'payday': null,
                'statement': {
                  'state': 'available',
                  'fileId': 'file-1',
                  'filename': 'statement.pdf',
                },
              },
            ]),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Approved'), findsOneWidget);
      expect(find.text('Paid'), findsNothing);
      expect(find.text('£23.20'), findsNWidgets(2));
      expect(find.text('Payday to be confirmed'), findsNWidgets(2));
      expect(find.text('View ›'), findsOneWidget);
    });

    testWidgets('venue photo falls back to a same-size placeholder', (
      tester,
    ) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Center(child: VenuePhoto(fileId: null, size: 64)),
        ),
      );
      final placeholder = find.byKey(const ValueKey('venue-photo-placeholder'));
      expect(placeholder, findsOneWidget);
      expect(tester.getSize(placeholder), const Size(64, 64));
      expect(find.byType(Image), findsNothing);
    });
  });
}
