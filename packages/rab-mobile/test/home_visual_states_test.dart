import 'support/location_stream_stub.dart';
import 'dart:async';
import 'package:intl/intl.dart';
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
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/core/models/attendance.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/theme/schedule_tokens.dart';
import 'package:rab_staff/core/theme/shift_visual_style.dart';
import 'package:rab_staff/features/home/schedule_clock_screen.dart';

import 'package:rab_staff/features/offers/schedule_offer_detail_screen.dart';
import 'package:rab_staff/features/home/attendance_provider.dart';
import 'package:rab_staff/features/home/widgets/upcoming_shift_card.dart';
import 'package:rab_staff/features/offers/offers_screen.dart';
import 'package:rab_staff/features/offers/schedule_offers_screen.dart';
import 'package:rab_staff/features/notifications/notifications_provider.dart';
import 'package:rab_staff/features/offers/offers_provider.dart';
import 'package:rab_staff/navigation/app_shell.dart';
import 'support/biometric_test_support.dart';

// Test-only API responses exercise the production widgets and providers.
// No alternate app entrypoint, production account, or backend data is changed.
void main() {
  setUp(stubLocationStream);
  tearDown(clearLocationStream);
  const capture = bool.fromEnvironment('HOME_VISUAL_CAPTURE');
  final boundary = GlobalKey();
  setUpAll(() async {
    // Layout checks and captures use the same real glyph metrics. Flutter's
    // default square test font does not represent the app's typography.
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
  tearDown(clearSecureStorageChannel);

  Future<void> shot(WidgetTester tester, String name) async {
    expect(tester.takeException(), isNull);
    if (!capture) return;
    final render =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final previousShadows = debugDisableShadows;
    try {
      // Capture actual blur, then restore the test binding's painting defaults.
      debugDisableShadows = false;
      void repaint(RenderObject object) {
        object.markNeedsPaint();
        object.visitChildren(repaint);
      }

      repaint(render);
      await tester.pump();
      await tester.runAsync(() async {
        final image = await render.toImage(pixelRatio: 2);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await File(
          '.qa-screenshots/home-$name.png',
        ).writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
    } finally {
      debugDisableShadows = previousShadows;
    }
  }

  Map<String, dynamic> offer(
    int i, {
    bool today = false,
    bool long = false,
    bool notes = false,
  }) {
    final now = DateTime.now();
    // A fixed midnight-8am window would drift into "already completed" once
    // the suite runs after 8am local time (real bug this exposed: a
    // manager_confirmed shift for today must stay clockable all day, not
    // just before a hardcoded clock hour) — anchor to "now" instead so the
    // fixture is always genuinely in-progress, deterministic regardless of
    // wall-clock time.
    final start = today
        ? now.subtract(const Duration(hours: 2))
        : DateTime(now.year, now.month, now.day + i + 1, 9);
    return {
      'id': 'visual-offer-$i',
      'shiftId': 'visual-shift-$i',
      'status': 'manager_confirmed',
      'sentAt': now.toIso8601String(),
      'expiresAt': now.add(const Duration(days: 30)).toIso8601String(),
      'startsAt': start.toIso8601String(),
      'endsAt': start.add(const Duration(hours: 8)).toIso8601String(),
      'venueName': long
          ? 'The Metropolitan Conference and Exhibition Centre'
          : 'Example Hotel ${i + 1}',
      'roleName': long
          ? 'Senior hospitality and conference supervisor'
          : 'Bartender',
      'estimatedPayPence': 9984,
      'staffProfileId': 'staff-1',
      'staffName': 'Alice Example',
      'payRatePence': 1248,
      'venueAddress': long
          ? '123 Exhibition Avenue, Westminster, Greater London, SW1A 1AA'
          : '12 Example Street, Bristol, BS1 2AB',
      'shiftNotes': notes ? 'Please use the staff entrance.' : null,
    };
  }

  Future<Completer<void>> mount(
    WidgetTester tester,
    Size size, {
    int count = 3,
    bool today = true,
    bool long = false,
    bool loading = false,
    int pending = 0,
    bool live = false,
    bool completed = false,
    double scale = 1,
    Map<String, int>? requests,
    bool reduced = false,
    bool notes = false,
    Map<String, String>? statuses,
    Map<String, bool>? failures,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    stubSecureStorageChannel({
      'rab.accessToken': 'test-access',
      'rab.refreshToken': 'test-refresh',
    });
    final gate = Completer<void>();
    if (!loading) gate.complete();
    final api = ApiClient(
      httpClient: MockClient((request) async {
        final path = request.url.path;
        if (requests != null) requests[path] = (requests[path] ?? 0) + 1;
        if (path.endsWith('/auth/me')) {
          return http.Response(jsonEncode(fakeUserJson()), 200);
        }
        if (path.endsWith('/offers/mine')) {
          await gate.future;
          if (failures?['offers'] == true) {
            return http.Response('{"message":"Unavailable"}', 503);
          }
          return http.Response(
            jsonEncode([
              if (today) offer(99, today: true, long: long, notes: notes),
              for (var i = 0; i < count; i++)
                offer(i, long: long, notes: notes),
              for (var i = 0; i < pending; i++)
                {
                  ...offer(50 + i, notes: notes),
                  'status': statuses?['visual-offer-${50 + i}'] ?? 'pending',
                },
            ]),
            200,
          );
        }
        if (path.endsWith('/accept')) {
          statuses?[path.split('/')[path.split('/').length - 2]] =
              'staff_accepted';
          return http.Response('{}', 200);
        }
        if (path.endsWith('/attendance/me/active')) {
          if (failures?['attendance'] == true) {
            return http.Response('{"message":"Unavailable"}', 503);
          }
          return http.Response(
            jsonEncode({
              'attendance': live
                  ? {
                      ...offer(99, today: true),
                      'id': 'attendance-1',
                      'status': 'clocked_in',
                      'clockInAt': DateTime.now()
                          .subtract(const Duration(minutes: 5))
                          .toIso8601String(),
                    }
                  : null,
              'serverNow': DateTime.now().toIso8601String(),
            }),
            200,
          );
        }
        if (path.endsWith('/attendance/me/history') && completed) {
          return http.Response(
            jsonEncode([
              {
                ...offer(99, today: true),
                'id': 'completed-attendance',
                'status': 'clocked_out',
                'clockInAt': DateTime.now()
                    .subtract(const Duration(minutes: 10))
                    .toIso8601String(),
                'clockOutAt': DateTime.now().toIso8601String(),
                'workedMinutes': 10,
              },
            ]),
            200,
          );
        }
        if (path.endsWith('/notifications/unread-count')) {
          return http.Response(jsonEncode({'count': 2}), 200);
        }
        return http.Response('[]', 200);
      }),
    );
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => AuthProvider(apiClient: api)),
          ChangeNotifierProvider(create: (_) => OffersProvider(api)),
          ChangeNotifierProvider(create: (_) => NotificationsProvider(api)),
          ChangeNotifierProvider(create: (_) => AttendanceProvider(api)),
        ],
        child: MaterialApp(
          theme: buildLightTheme(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              padding: const EdgeInsets.only(top: 44, bottom: 24),
              viewPadding: const EdgeInsets.only(top: 44, bottom: 24),
              textScaler: TextScaler.linear(scale),
              disableAnimations: reduced,
            ),
            child: RepaintBoundary(key: boundary, child: child!),
          ),
          home: const AppShell(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return gate;
  }

  testWidgets('Home respects completed attendance before scheduled end', (
    tester,
  ) async {
    await mount(tester, const Size(393, 852), completed: true);
    expect(find.text('Completed'), findsOneWidget);
    expect(find.text('Clock in'), findsNothing);
    expect(find.text('Clock out'), findsNothing);
  });

  for (final count in [1, 5]) {
    testWidgets('Schedule visual review $count actual cards', (tester) async {
      await mount(tester, const Size(393, 852), today: false, count: count);
      await shot(tester, 'offers-stack-$count');
      await tester.drag(
        find.byKey(const ValueKey('upcoming-deck')),
        const Offset(0, -130),
      );
      await tester.pumpAndSettle();
      await shot(tester, 'offers-stack-$count-swiped');
    });
  }

  for (final width in [320.0, 393.0, 430.0]) {
    testWidgets('Whole deck hands off on press and return at $width', (
      tester,
    ) async {
      await mount(tester, Size(width, 852), today: false, count: 3);
      final front = find.descendant(
        of: find.byKey(const ValueKey('deck-card-visual-offer-0')),
        matching: find.byType(UpcomingShiftCard),
      );
      await tester.ensureVisible(front);
      await tester.pumpAndSettle();
      final before = tester.getRect(front);
      final press = await tester.startGesture(before.center);
      await tester.pump(const Duration(milliseconds: 120));
      expect(tester.getRect(front), before);
      expect(
        tester
            .widget<Opacity>(
              find.byKey(const ValueKey('deck-layer-visual-offer-0')),
            )
            .opacity,
        1,
      );
      await shot(tester, 'nav-card-$width-pressed');
      await press.up();
      await tester.pump();
      for (final elapsed in [16, 34, 60, 120, 200]) {
        await tester.pump(Duration(milliseconds: elapsed));
        for (var i = 0; i < 3; i++) {
          expect(
            tester
                .widget<Opacity>(
                  find.byKey(
                    ValueKey('deck-layer-visual-offer-$i'),
                    skipOffstage: false,
                  ),
                )
                .opacity,
            0,
            reason:
                'The route owns the foreground; all source layers must be hidden',
          );
        }
        expect(tester.takeException(), isNull);
      }
      await tester.pumpAndSettle();
      expect(find.byType(ScheduleOfferDetailScreen), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(
        tester
            .widget<Opacity>(
              find.byKey(
                const ValueKey('deck-layer-visual-offer-1'),
                skipOffstage: false,
              ),
            )
            .opacity,
        0,
      );
      await tester.pump(const Duration(milliseconds: 101));
      expect(
        tester
            .widget<Opacity>(
              find.byKey(
                const ValueKey('deck-layer-visual-offer-0'),
                skipOffstage: false,
              ),
            )
            .opacity,
        1,
        reason: 'Restore in the dismissal frame, without a blank handoff',
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(front), before);
      expect(
        tester
            .widget<Opacity>(
              find.byKey(const ValueKey('deck-layer-visual-offer-0')),
            )
            .opacity,
        1,
      );
      expect(tester.takeException(), isNull);
    });
  }

  for (final state in [
    'offer',
    'pending',
    'ready',
    'eligible',
    'active',
    'completed',
  ]) {
    testWidgets('Schedule confirmed detail attendance state $state', (
      tester,
    ) async {
      await mount(
        tester,
        const Size(393, 852),
        today: state != 'ready',
        count: state == 'ready' ? 1 : 0,
        live: state == 'active',
        notes: true,
      );
      final context = tester.element(find.byType(AppShell));
      final provider = context.read<OffersProvider>();
      var selected = provider.offers.first;
      if (state == 'offer' || state == 'pending') {
        selected = OfferSummary.fromJson({
          ...offer(99, today: true, notes: true),
          'status': state == 'offer' ? 'pending' : 'staff_accepted',
        });
        provider.offers = [selected];
      }
      if (state == 'completed') {
        context.read<AttendanceProvider>().history = [
          AttendanceSummary.fromJson({
            ...offer(99, today: true),
            'id': 'attendance-completed',
            'status': 'clocked_out',
            'clockInAt': DateTime.now()
                .subtract(const Duration(hours: 2))
                .toIso8601String(),
            'clockOutAt': DateTime.now().toIso8601String(),
          }),
        ];
        selected = OfferSummary.fromJson({
          ...offer(99, today: true, notes: true),
          'endsAt': DateTime.now()
              .subtract(const Duration(minutes: 1))
              .toIso8601String(),
        });
        provider.offers = [selected];
      }
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ScheduleOfferDetailScreen(
            offer: selected,
            visualStyle: ShiftVisualStyle.yellow,
          ),
        ),
      );
      await tester.pumpAndSettle();
      if (state == 'completed') {
        expect(find.text('Complete'), findsOneWidget);
        expect(find.text('Shift completed'), findsNothing);
        expect(find.text('Back to shifts'), findsNothing);
        expect(find.text('Clock In'), findsNothing);
      } else if (state == 'offer') {
        expect(find.text('Pending'), findsOneWidget);
        expect(find.text('Accept'), findsOneWidget);
        expect(find.text('Decline'), findsOneWidget);
      } else if (state == 'pending') {
        expect(find.text('Pending'), findsOneWidget);
        expect(find.text('Waiting for confirmation'), findsNothing);
      } else if (state == 'ready') {
        expect(find.text('Be Ready'), findsNothing);
      } else {
        final label = state == 'active'
            ? 'Clock Out'
            : state == 'ready'
            ? 'Be Ready'
            : 'Clock In';
        expect(
          tester
              .widget<FilledButton>(find.widgetWithText(FilledButton, label))
              .onPressed,
          isNotNull,
        );
      }
      expect(find.text('NOTE'), findsOneWidget);
      expect(find.text('Please use the staff entrance.'), findsOneWidget);
      expect(find.text('Accepted by you'), findsNothing);
      await shot(tester, 'offers-attendance-$state');
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'Detail attendance error shows retry rather than grey clock action',
    (tester) async {
      final failures = {'attendance': true};
      await mount(
        tester,
        const Size(393, 852),
        today: true,
        count: 0,
        failures: failures,
      );
      final context = tester.element(find.byType(AppShell));
      final selected = context.read<OffersProvider>().offers.single;
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ScheduleOfferDetailScreen(offer: selected),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('Could not check attendance. Please try again.'),
        findsOneWidget,
      );
      expect(find.text('Clock In'), findsNothing);
      expect(find.text('NOTE'), findsOneWidget);
      expect(find.text('No Details'), findsOneWidget);
      failures['attendance'] = false;
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, 'Clock In'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Detail loading is distinct from unavailable attendance', (
    tester,
  ) async {
    final gate = await mount(
      tester,
      const Size(393, 852),
      today: true,
      count: 0,
      loading: true,
    );
    final context = tester.element(find.byType(AppShell));
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ScheduleOfferDetailScreen(
          offer: OfferSummary.fromJson(offer(99, today: true)),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.text('Loading'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Clock In'), findsNothing);
    gate.complete();
    await tester.pumpAndSettle();
    expect(find.widgetWithText(FilledButton, 'Clock In'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  for (final style in ShiftVisualStyle.values) {
    testWidgets('Isolated detail visual ${style.name}', (tester) async {
      await mount(
        tester,
        const Size(393, 852),
        today: false,
        count: 0,
        pending: 1,
        notes: true,
      );
      final context = tester.element(find.byType(AppShell));
      final selected = context.read<OffersProvider>().offers.single;
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              ScheduleOfferDetailScreen(offer: selected, visualStyle: style),
        ),
      );
      await tester.pumpAndSettle();
      await shot(tester, 'isolated-offers-${style.name}-detail');
    });
  }

  testWidgets(
    'Offers list carries all five rendered colours into detail and back',
    (tester) async {
      await mount(
        tester,
        const Size(393, 852),
        today: false,
        count: 0,
        pending: 5,
        notes: true,
      );
      final context = tester.element(find.byType(AppShell));
      Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => const ScheduleOffersScreen()),
      );
      await tester.pumpAndSettle();
      for (var i = 0; i < 5; i++) {
        final source = find.byKey(ValueKey('visual-offer-${50 + i}'));
        await tester.scrollUntilVisible(
          source,
          160,
          scrollable: find
              .descendant(
                of: find.byType(ScheduleOffersScreen),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        await tester.pumpAndSettle();
        final rect = tester.getRect(source);
        final style = ShiftVisualStyle.forShift('visual-shift-${50 + i}');
        await shot(tester, 'offers-${style.name}-source');
        await tester.tap(
          find.descendant(of: source, matching: find.byType(IconButton)),
        );
        await tester.pumpAndSettle();
        final detail = tester.widget<ScheduleOfferDetailScreen>(
          find.byType(ScheduleOfferDetailScreen),
        );
        expect(detail.offer.id, 'visual-offer-${50 + i}');
        expect(detail.visualStyle, style);
        await shot(tester, 'offers-${style.name}-detail');
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
        expect(tester.getRect(source), rect);
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets('Schedule error differs from empty and retry recovers', (
    tester,
  ) async {
    final failures = {'offers': true};
    await mount(
      tester,
      const Size(393, 852),
      today: false,
      count: 0,
      failures: failures,
    );
    expect(
      find.text('Could not load offers. Please try again.'),
      findsOneWidget,
    );
    expect(find.text('No shift today'), findsNothing);
    final context = tester.element(find.byType(AppShell));
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const ScheduleOffersScreen()),
    );
    await tester.pumpAndSettle();
    expect(
      find.text('No pending offers. New offers will appear here.'),
      findsNothing,
    );
    failures['offers'] = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(
      find.text('No pending offers. New offers will appear here.'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Schedule acceptance refreshes detail and confirmation moves categories',
    (tester) async {
      final statuses = <String, String>{};
      await mount(
        tester,
        const Size(393, 852),
        today: false,
        count: 0,
        pending: 1,
        statuses: statuses,
        notes: true,
      );
      final context = tester.element(find.byType(AppShell));
      Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => const ScheduleOffersScreen()),
      );
      await tester.pumpAndSettle();
      expect(find.text('PENDING'), findsOneWidget);
      await shot(tester, 'offers-pending-list');
      await tester.tap(find.byTooltip('Open Bartender'));
      await tester.pumpAndSettle();
      await shot(tester, 'offers-pending-detail');
      await tester.tap(find.text('Accept'));
      await tester.pumpAndSettle();
      expect(find.text('Accept'), findsNothing);
      expect(
        find.descendant(
          of: find.byType(ScheduleOfferDetailScreen),
          matching: find.text('Waiting for confirmation'),
        ),
        findsNothing,
      );
      await shot(tester, 'offers-waiting-detail');
      statuses['visual-offer-50'] = 'manager_confirmed';
      await context.read<OffersProvider>().refresh();
      await tester.pumpAndSettle();
      expect(find.text('Confirmed'), findsOneWidget);
      expect(find.text('Be Ready'), findsNothing);
      await shot(tester, 'offers-confirmed-detail');
      Navigator.of(context).pop();
      await tester.pumpAndSettle();
      expect(find.text('PENDING'), findsNothing);
      expect(
        find.text('No pending offers. New offers will appear here.'),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Confirmed'));
      await tester.pumpAndSettle();
      expect(find.text('CONFIRMED'), findsOneWidget);
      await shot(tester, 'offers-confirmed-list');
      expect(tester.takeException(), isNull);
    },
  );

  for (final variant in ['Next Shift', "Today's Shift", 'Live Shift']) {
    testWidgets('$variant whole card opens the same details and reverses', (
      tester,
    ) async {
      await mount(
        tester,
        const Size(393, 852),
        count: 1,
        today: variant != 'Next Shift',
        live: variant == 'Live Shift',
      );
      final heading = find.text(variant);
      expect(heading, findsOneWidget);
      final displayed = tester
          .element(heading)
          .read<OffersProvider>()
          .offers
          .firstWhere(
            (o) =>
                o.shiftId ==
                (variant == 'Next Shift'
                    ? 'visual-shift-0'
                    : 'visual-shift-99'),
          );
      expect(find.text(displayed.venueAddress!), findsNothing);
      expect(
        find.text(
          DateFormat('EEE dd/MM/yy').format(displayed.startsAt.toLocal()),
        ),
        findsOneWidget,
      );
      final upcomingCards = find.byType(UpcomingShiftCard).evaluate();
      if (upcomingCards.isNotEmpty) {
        final upcoming =
            (upcomingCards.first.widget as UpcomingShiftCard).offer;
        expect(
          find.text(
            '${DateFormat('EEE dd/MM/yy').format(upcoming.startsAt.toLocal())} \u00b7 '
            '${DateFormat('HH:mm').format(upcoming.startsAt.toLocal())}\u2013${DateFormat('HH:mm').format(upcoming.endsAt.toLocal())}',
          ),
          findsWidgets,
        );
        expect(find.text('Team Member'), findsWidgets);
      }
      await tester.tap(heading);
      await tester.pumpAndSettle();
      final detail = tester.widget<ScheduleOfferDetailScreen>(
        find.byType(ScheduleOfferDetailScreen),
      );
      final shiftId = variant == 'Next Shift'
          ? 'visual-shift-0'
          : 'visual-shift-99';
      expect(detail.offer.shiftId, shiftId);
      expect(detail.visualStyle, ShiftVisualStyle.forShift(shiftId));
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(heading, findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'Every View All pastel reaches matching detail and reverses to the same source',
    (tester) async {
      await mount(
        tester,
        const Size(393, 852),
        today: false,
        count: 5,
        notes: true,
      );
      await tester.tap(find.bySemanticsLabel('View all upcoming shifts'));
      await tester.pumpAndSettle();
      for (var i = 0; i < 5; i++) {
        final visibleStyle = ShiftVisualStyle.forShift('visual-shift-$i');
        final list = tester.widget<SingleChildScrollView>(
          find.byType(SingleChildScrollView),
        );
        list.controller!.jumpTo(
          i *
              (UpcomingShiftCard.heightFor(
                    tester.element(find.byType(AppShell)),
                    schedule: true,
                  ) +
                  16),
        );
        await tester.pumpAndSettle();
        final card = find.byKey(ValueKey('expanded-visual-offer-$i'));
        final sourceRect = tester.getRect(card);
        final rendered = tester.widget<UpcomingShiftCard>(card);
        expect(rendered.visualStyle, visibleStyle);
        expect(rendered.backgroundOverride, isNull);
        await shot(tester, 'style-${visibleStyle.name}-source');
        await tester.tap(
          find.descendant(of: card, matching: find.byType(TextButton)),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 180));
        final page = tester.widget<ScheduleOfferDetailScreen>(
          find.byType(ScheduleOfferDetailScreen),
        );
        expect(page.visualStyle, visibleStyle);
        expect(page.offer.id, 'visual-offer-$i');
        expect(page.offer.shiftId, 'visual-shift-$i');
        await shot(tester, 'style-${visibleStyle.name}-opening');
        await tester.pumpAndSettle();
        final scaffold = tester.widget<Scaffold>(
          find
              .descendant(
                of: find.byType(ScheduleOfferDetailScreen),
                matching: find.byType(Scaffold),
              )
              .first,
        );
        expect(scaffold.backgroundColor, visibleStyle.page);
        expect(find.text('Confirmed'), findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(ScheduleOfferDetailScreen),
            matching: find.text('Be Ready'),
          ),
          findsNothing,
        );
        expect(find.text('Please use the staff entrance.'), findsOneWidget);
        final noteSurfaces = tester.widgetList<Container>(
          find.ancestor(
            of: find.text('NOTE'),
            matching: find.byType(Container),
          ),
        );
        expect(
          noteSurfaces.any(
            (box) =>
                box.decoration is BoxDecoration &&
                (box.decoration as BoxDecoration).color ==
                    visibleStyle.noteChip,
          ),
          isTrue,
        );
        expect(find.byType(FilledButton), findsNothing);
        await shot(tester, 'style-${visibleStyle.name}-detail');
        await tester.binding.handlePopRoute();
        await tester.pumpAndSettle();
        expect(tester.getRect(card), sourceRect);
        expect(
          tester.widget<UpcomingShiftCard>(card).visualStyle,
          visibleStyle,
        );
        await shot(tester, 'style-${visibleStyle.name}-returned');
      }
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
    },
  );

  for (final selected in [1, 3]) {
    testWidgets('Swiped Schedule card retains its shift style $selected', (
      tester,
    ) async {
      await mount(tester, const Size(393, 852), today: false, count: 5);
      final deck = find.byKey(const ValueKey('upcoming-deck'));
      for (var step = 0; step < selected; step++) {
        await tester.drag(deck, const Offset(0, -140));
        await tester.pumpAndSettle();
      }
      await tester.pumpAndSettle();
      expect(
        tester
            .widgetList<Semantics>(find.byType(Semantics))
            .map((s) => s.properties.label)
            .whereType<String>()
            .where((label) => label.startsWith('Upcoming shift'))
            .toList(),
        contains('Upcoming shift ${selected + 1} of 5'),
      );
      await shot(tester, 'rotation-$selected-source');
      await tester.tap(
        find.bySemanticsLabel('Open shift at Example Hotel ${selected + 1}'),
      );
      await tester.pumpAndSettle();
      final page = tester.widget<ScheduleOfferDetailScreen>(
        find.byType(ScheduleOfferDetailScreen),
      );
      expect(page.offer.id, 'visual-offer-$selected');
      expect(
        page.visualStyle,
        ShiftVisualStyle.forShift('visual-shift-$selected'),
      );
      await shot(tester, 'rotation-$selected-detail');
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(
        find.bySemanticsLabel(RegExp('Upcoming shift ${selected + 1} of 5')),
        findsOneWidget,
      );
    });
  }

  testWidgets(
    'Early Back restores every source layer after morph cancellation',
    (tester) async {
      await mount(tester, const Size(393, 852), today: false, count: 3);
      final front = find.byKey(const ValueKey('deck-card-visual-offer-0'));
      final source = tester.getRect(front);
      await tester.tap(find.bySemanticsLabel('Open shift at Example Hotel 1'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 32));
      expect(
        find.byKey(const ValueKey('detail-source-content')),
        findsOneWidget,
      );
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(ScheduleOfferDetailScreen), findsNothing);
      expect(tester.getRect(front), source);
      for (var i = 0; i < 3; i++) {
        expect(
          tester
              .widget<Opacity>(
                find.byKey(ValueKey('deck-layer-visual-offer-$i')),
              )
              .opacity,
          closeTo(1 - i * .18, .0001),
        );
      }
      await tester.tap(find.bySemanticsLabel('Open shift at Example Hotel 1'));
      await tester.pumpAndSettle();
      expect(find.byType(ScheduleOfferDetailScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (var selected = 0; selected < 5; selected++) {
    testWidgets('Stationary surface transition colour $selected', (
      tester,
    ) async {
      await mount(
        tester,
        selected == 0
            ? const Size(360, 640)
            : selected == 4
            ? const Size(430, 932)
            : const Size(393, 852),
        today: false,
        count: 5,
      );
      final deck = find.byKey(const ValueKey('upcoming-deck'));
      for (var step = 0; step < selected; step++) {
        await tester.drag(deck, const Offset(0, -140));
        await tester.pumpAndSettle();
      }
      final originalCard = find.descendant(
        of: find.byKey(ValueKey('deck-card-visual-offer-$selected')),
        matching: find.byType(UpcomingShiftCard),
      );
      await tester.ensureVisible(originalCard);
      await tester.pumpAndSettle();
      final source = tester.getRect(originalCard);
      final arrow = find.bySemanticsLabel(
        'Open shift at Example Hotel ${selected + 1}',
      );
      final tapPosition = tester.getCenter(arrow);
      await tester.tapAt(tapPosition);
      await tester.tapAt(tapPosition);
      await tester.pump();
      final surface = find.byKey(const ValueKey('detail-expansion-surface'));
      await tester.pump(const Duration(milliseconds: 50));
      expect(surface, findsOneWidget);
      expect(tester.getRect(surface), source);
      expect(tester.getRect(originalCard), source);
      expect(
        tester
            .widget<Opacity>(
              find.byKey(const ValueKey('detail-source-content')),
            )
            .opacity,
        closeTo(.5, .01),
      );
      expect(
        tester
            .widget<Opacity>(
              find.byKey(const ValueKey('detail-content-entrance')),
            )
            .opacity,
        0,
      );
      await shot(tester, 'stationary-$selected-fade');
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const ValueKey('detail-source-content')), findsNothing);
      expect(
        tester
            .widget<Opacity>(
              find.byKey(const ValueKey('detail-content-entrance')),
            )
            .opacity,
        0,
      );
      final growing = tester.getRect(surface);
      expect(growing.left, lessThan(source.left));
      expect(growing.right, greaterThan(source.right));
      expect(growing.top, lessThan(source.top));
      expect(growing.bottom, greaterThan(source.bottom));
      await shot(tester, 'stationary-$selected-surface');
      await tester.pump(const Duration(milliseconds: 200));
      expect(
        tester.getTopLeft(
          find.byKey(const ValueKey('detail-content-entrance')),
        ),
        Offset.zero,
      );
      final entering = tester
          .widget<Opacity>(
            find.byKey(const ValueKey('detail-content-entrance')),
          )
          .opacity;
      expect(entering, greaterThan(0));
      expect(entering, lessThan(1));
      await shot(tester, 'stationary-$selected-entrance');
      await tester.pumpAndSettle();
      final detail = tester.widget<ScheduleOfferDetailScreen>(
        find.byType(ScheduleOfferDetailScreen),
      );
      expect(detail.offer.id, 'visual-offer-$selected');
      expect(
        detail.visualStyle,
        ShiftVisualStyle.forShift('visual-shift-$selected'),
      );
      expect(find.byKey(const ValueKey('detail-source-content')), findsNothing);
      await shot(tester, 'stationary-$selected-open');
      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(tester.getRect(surface), source);
      expect(
        tester
            .widget<Opacity>(
              find.byKey(const ValueKey('detail-content-entrance')),
            )
            .opacity,
        0,
      );
      await tester.pumpAndSettle();
      expect(tester.getRect(originalCard), source);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Reduced motion detail fades without a spatial morph', (
    tester,
  ) async {
    await mount(
      tester,
      const Size(393, 852),
      today: false,
      count: 1,
      reduced: true,
    );
    await tester.tap(find.bySemanticsLabel('Open shift at Example Hotel 1'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 70));
    expect(
      tester.getRect(find.byKey(const ValueKey('detail-expansion-surface'))),
      const Rect.fromLTWH(0, 0, 393, 852),
    );
    expect(find.byKey(const ValueKey('detail-source-content')), findsNothing);
    expect(
      tester
          .widget<Opacity>(
            find.byKey(const ValueKey('detail-content-entrance')),
          )
          .opacity,
      closeTo(.5, .01),
    );
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(
      find.bySemanticsLabel('Open shift at Example Hotel 1'),
      findsOneWidget,
    );
  });
  for (final size in [
    const Size(360, 640),
    const Size(393, 852),
    const Size(432, 960),
    const Size(375, 667),
    const Size(390, 844),
    const Size(430, 932),
  ]) {
    testWidgets('Schedule Organization and My Space at $size', (tester) async {
      await mount(tester, size, pending: 2);
      expect(find.text('Offer Details'), findsOneWidget);
      expect(find.text('2 offers – View'), findsOneWidget);
      expect(find.text('Alice'), findsOneWidget);
      await shot(tester, 'schedule-organization-${size.width.toInt()}');
      await tester.tap(find.text('My Space'));
      await tester.pumpAndSettle();
      expect(find.text('Overview'), findsOneWidget);
      expect(find.text('Discover the app'), findsOneWidget);
      await shot(tester, 'schedule-my-space-${size.width.toInt()}');
      final pill = tester.getRect(
        find.byKey(const ValueKey('moving-tab-pill')),
      );
      expect(pill.bottom, lessThan(size.height - 24));
    });
  }

  testWidgets(
    'Provider identity is preserved across Home rebuilds without API reloads',
    (tester) async {
      final requests = <String, int>{};
      await mount(tester, const Size(393, 852), requests: requests);
      final shell = tester.element(find.byType(AppShell));
      final auth = shell.read<AuthProvider>();
      final offers = shell.read<OffersProvider>();
      final attendance = shell.read<AttendanceProvider>();
      final before = Map.of(requests);
      for (var i = 0; i < 3; i++) {
        await tester.pumpAndSettle();
        expect(find.text('Offer Details'), findsOneWidget);
        final selected = tester.widget<DecoratedBox>(
          find.byKey(const ValueKey('moving-tab-pill')),
        );
        expect(
          (selected.decoration as BoxDecoration).color,
          ScheduleTokens.accent,
        );
      }
      expect(shell.read<AuthProvider>(), same(auth));
      expect(shell.read<OffersProvider>(), same(offers));
      expect(shell.read<AttendanceProvider>(), same(attendance));
      expect(requests, before);
    },
  );

  testWidgets('Schedule zero data, unavailable payroll and local first steps', (
    tester,
  ) async {
    await mount(tester, const Size(393, 852), today: false, count: 0);
    // Shown in both the left "Today's Shift" panel and the right clock
    // action now that the clock action no longer says the vague/incorrect
    // "Not available" for a genuinely empty day (§28/§40 #1).
    expect(find.text('No shift today'), findsNWidgets(2));
    expect(find.text('0 offers – View'), findsOneWidget);
    await tester.tap(find.text('No shift today').last);
    await tester.pumpAndSettle();
    expect(find.byType(ScheduleClockScreen), findsNothing);
    await shot(tester, 'schedule-empty');
    await tester.tap(find.text('My Space'));
    await tester.pumpAndSettle();
    expect(find.text('0'), findsNWidgets(3));
    expect(find.text('—'), findsOneWidget);
    await tester.tap(find.text('Discover the app'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Review invitations in Offers'), findsOneWidget);
    await tester.tap(find.text('Got it'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Dismiss Discover the app'));
    await tester.pumpAndSettle();
    expect(find.text('Discover the app'), findsNothing);
    await tester.tap(find.text('My availability'));
    await tester.pumpAndSettle();
    expect(
      find.textContaining('Availability editing is not available'),
      findsOneWidget,
    );
    await tester.tap(find.text('Got it'));
    await tester.pumpAndSettle();
  });

  testWidgets(
    'Schedule actions use existing offers, clock, detail and calendar routes',
    (tester) async {
      final requests = <String, int>{};
      await mount(tester, const Size(393, 852), pending: 2, requests: requests);
      await tester.tap(find.text('2 offers – View'));
      await tester.pumpAndSettle();
      expect(find.byType(OffersScreen), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.tap(find.text('Clock in'));
      await tester.pumpAndSettle();
      expect(find.byType(ScheduleClockScreen), findsOneWidget);
      expect(requests.keys.where((p) => p.contains('/clock-in')), isEmpty);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      final arrow = find.bySemanticsLabel('Open shift at Example Hotel 1');
      await tester.ensureVisible(arrow);
      await tester.tap(arrow);
      await tester.pumpAndSettle();
      expect(find.byType(ScheduleOfferDetailScreen), findsOneWidget);
      await shot(tester, 'schedule-detail');
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('My Space'));
      await tester.tap(find.text('My Space'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Confirmed'));
      await tester.pumpAndSettle();
      expect(find.byType(ScheduleOffersScreen), findsOneWidget);
    },
  );

  testWidgets('Schedule enlarged text and active clock state', (tester) async {
    await mount(
      tester,
      const Size(360, 800),
      long: true,
      scale: 1.5,
      live: true,
    );
    expect(find.text('Live Shift'), findsOneWidget);
    expect(find.text('Clock out'), findsOneWidget);
    await shot(tester, 'schedule-large-text');
    await tester.tap(find.text('My Space'));
    await tester.pumpAndSettle();
    await shot(tester, 'schedule-my-space-large-text');
  });

  testWidgets('Schedule loading has no invented counts', (tester) async {
    final gate = await mount(
      tester,
      const Size(393, 852),
      loading: true,
      today: false,
    );
    expect(find.text('Updating your offers…'), findsOneWidget);
    expect(find.text('0 offers – View'), findsNothing);
    await shot(tester, 'schedule-loading');
    gate.complete();
    await tester.pumpAndSettle();
    expect(find.text('Updating your offers…'), findsNothing);
  });

  testWidgets(
    'Schedule large text and reduced motion retain tab and deck actions',
    (tester) async {
      await mount(
        tester,
        const Size(320, 640),
        long: true,
        scale: 2,
        reduced: true,
      );
      await shot(tester, 'schedule-accessible-organization');
      await tester.ensureVisible(find.text('My Space'));
      await tester.tap(find.text('My Space'));
      await tester.pumpAndSettle();
      await shot(tester, 'schedule-accessible-my-space');
      await tester.ensureVisible(find.text('organization'));
      await tester.tap(find.text('organization'));
      await tester.pumpAndSettle();
      final deck = find.byKey(const ValueKey('upcoming-deck'));
      await tester.ensureVisible(deck);
      await tester.pumpAndSettle();
      final bounds = tester.getRect(deck);
      await tester.dragFrom(
        Offset(160, bounds.top.clamp(120.0, 320.0) + 80),
        const Offset(0, -100),
      );
      await tester.pumpAndSettle();
      expect(
        find.bySemanticsLabel(RegExp('Upcoming shift 2 of 3')),
        findsOneWidget,
      );
      await shot(tester, 'schedule-accessible-deck');
    },
  );

  testWidgets('Long content and enlarged text remain usable', (tester) async {
    await mount(tester, const Size(360, 800), count: 1, long: true, scale: 1.5);
    await shot(tester, 'large-text');
    await tester.drag(find.byType(ListView).first, const Offset(0, -360));
    await tester.pumpAndSettle();
    await shot(tester, 'large-text-scrolled');
  });

  testWidgets('Production composition transition captures and restoration', (
    tester,
  ) async {
    await mount(tester, const Size(393, 852), count: 8);
    final open = find.bySemanticsLabel('Open shift at Example Hotel 1');
    final source = tester.getRect(open);
    await shot(tester, 'idle');
    final deck = find.byKey(const ValueKey('upcoming-deck'));
    final drag = await tester.startGesture(
      tester.getTopLeft(deck) + const Offset(100, 100),
    );
    await drag.moveBy(const Offset(0, -25));
    await tester.pump();
    await drag.moveBy(const Offset(0, -30));
    await tester.pump();
    await shot(tester, 'mid-drag');
    expect(tester.getTopLeft(open).dy, lessThan(source.top));
    await drag.cancel();
    await tester.pumpAndSettle();
    expect(tester.getRect(open), source);
    await tester.drag(deck, const Offset(0, -130));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 130));
    await shot(tester, 'cycle-up-out');
    await tester.pump(const Duration(milliseconds: 110));
    await shot(tester, 'cycle-up-return');
    await tester.pumpAndSettle();
    await shot(tester, 'cycle-up-complete');
    expect(
      find.bySemanticsLabel('Open shift at Example Hotel 2'),
      findsOneWidget,
    );
    await tester.drag(deck, const Offset(0, 130));
    await tester.pumpAndSettle();
    await shot(tester, 'cycle-down-complete');
    expect(tester.getRect(open), source);
    final press = await tester.startGesture(tester.getCenter(open));
    await tester.pump(const Duration(milliseconds: 80));
    await shot(tester, 'arrow-press');
    await press.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 110));
    await tester.pump(const Duration(milliseconds: 160));
    await shot(tester, 'detail-opening');
    await tester.pumpAndSettle();
    await shot(tester, 'detail');
    await tester.binding.handlePopRoute();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 220));
    await shot(tester, 'detail-back');
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('View all upcoming shifts'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 110));
    await tester.pump(const Duration(milliseconds: 90));
    await shot(tester, 'expansion-early');
    await tester.pumpAndSettle();
    await shot(tester, 'expanded');
    await tester.fling(
      find.byKey(const ValueKey('expanded-visual-offer-0')),
      const Offset(0, -350),
      800,
    );
    await tester.pumpAndSettle();
    await shot(tester, 'wallet-scroll');
    await tester.binding.handlePopRoute();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 240));
    await shot(tester, 'collapse');
    await tester.pumpAndSettle();
    await shot(tester, 'restored');
    expect(tester.getRect(open), source);
    await tester.tap(find.byTooltip('Calendar'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 160));
    await shot(tester, 'nav-middle');
    await tester.pumpAndSettle();
    await shot(tester, 'nav-calendar');
    await tester.tap(find.byTooltip('Home'));
    await tester.pumpAndSettle();
    expect(open, findsOneWidget);
    await shot(tester, 'nav-home-restored');
  });
}
