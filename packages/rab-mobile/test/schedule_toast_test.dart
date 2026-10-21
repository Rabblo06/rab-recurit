import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/theme/schedule_tokens.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/schedule_feedback.dart';
import 'package:rab_staff/core/widgets/schedule_toast.dart';

/// `--dart-define=TOAST_CAPTURE_DIR=<dir>` also writes flutter-*.png renders.
const _captureDir = String.fromEnvironment('TOAST_CAPTURE_DIR');

final _home = GlobalKey();

Future<BuildContext> _mount(
  WidgetTester tester, {
  Size size = const Size(393, 852),
  double textScale = 1,
  bool reduced = false,
  Widget? body,
  Key? appBoundary,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: buildLightTheme(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          textScaler: TextScaler.linear(textScale),
          disableAnimations: reduced,
        ),
        // Wraps the Navigator, so a capture includes the root overlay.
        child: RepaintBoundary(key: appBoundary, child: child!),
      ),
      home: Scaffold(
        key: _home,
        backgroundColor: ScheduleTokens.background,
        body: body ?? const SizedBox.expand(),
      ),
    ),
  );
  return _home.currentContext!;
}

Finder get _cards => find.byType(ScheduleToastCard);

/// Animations finish strictly after their duration.
const _afterExit = Duration(milliseconds: 176);

/// One frame to start the exit ticker, then past its end, then the rebuild.
Future<void> _exit(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(_afterExit);
  await tester.pump();
}

double _fill(WidgetTester tester) => tester
    .widget<FractionallySizedBox>(
      find.descendant(
        of: _cards.first,
        matching: find.byType(FractionallySizedBox),
      ),
    )
    .widthFactor!;

void main() {
  setUpAll(() async {
    final fonts =
        '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts';
    for (final entry in {
      'Roboto': 'roboto-regular.ttf',
      'MaterialIcons': 'materialicons-regular.otf',
    }.entries) {
      await (FontLoader(entry.key)..addFont(
            File(
              '$fonts/${entry.value}',
            ).readAsBytes().then(ByteData.sublistView),
          ))
          .load();
    }
  });

  group('ScheduleToast variants', () {
    for (final (kind, icon, textColor, fill) in [
      (
        ScheduleMessageKind.error,
        Icons.error_outline_rounded,
        ScheduleTokens.errorText,
        ScheduleTokens.toastErrorFill,
      ),
      (
        ScheduleMessageKind.success,
        Icons.check_circle_outline_rounded,
        ScheduleTokens.successText,
        ScheduleTokens.toastSuccessFill,
      ),
      (
        ScheduleMessageKind.warning,
        Icons.warning_amber_rounded,
        ScheduleTokens.warningText,
        ScheduleTokens.toastWarningFill,
      ),
      (
        ScheduleMessageKind.info,
        Icons.info_outline_rounded,
        ScheduleTokens.ink,
        ScheduleTokens.toastInfoFill,
      ),
    ]) {
      testWidgets(
        '${kind.name}: icon, text colour, fill, dismiss, live region',
        (tester) async {
          final context = await _mount(tester);
          expect(
            ScheduleToast.show(context, 'Saved ${kind.name}', kind: kind),
            isTrue,
          );
          await tester.pump();
          await tester.pump(ScheduleToast.appearDuration);
          final card = find.byKey(ValueKey('schedule-toast-${kind.name}'));
          expect(card, findsOneWidget);
          expect(
            find.descendant(of: card, matching: find.byIcon(icon)),
            findsOneWidget,
          );
          final text = tester.widget<Text>(find.text('Saved ${kind.name}'));
          // Text stays neutral (owner reference); icon + fill carry the kind.
          expect(text.style!.color, ScheduleTokens.ink);
          expect(textColor, isNotNull);
          expect(
            tester
                .widget<ColoredBox>(
                  find.descendant(of: card, matching: find.byType(ColoredBox)),
                )
                .color,
            fill,
          );
          expect(tester.widget<Semantics>(card).properties.liveRegion, isTrue);
          final dismiss = find.byKey(const ValueKey('schedule-toast-dismiss'));
          expect(tester.getSize(dismiss).height, greaterThanOrEqualTo(48));
          expect(tester.getSize(dismiss).width, greaterThanOrEqualTo(48));
          await tester.tap(dismiss);
          await tester.pumpAndSettle();
          expect(_cards, findsNothing);
        },
      );
    }
  });

  testWidgets('auto-dismiss: success/info ~4.5s, warning/error ~7s', (
    tester,
  ) async {
    final context = await _mount(tester);
    ScheduleToast.show(
      context,
      'Review saved.',
      kind: ScheduleMessageKind.success,
    );
    ScheduleToast.show(
      context,
      'The PDF could not be saved.',
      kind: ScheduleMessageKind.error,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 4400));
    expect(find.text('Review saved.'), findsOneWidget);
    // The fill drains with the remaining time.
    expect(_fill(tester), lessThan(.1));
    await tester.pump(const Duration(milliseconds: 101)); // 4.501s: done
    await _exit(tester); // now 4.677s
    expect(find.text('Review saved.'), findsNothing);
    expect(find.text('The PDF could not be saved.'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 2223)); // 6.9s
    expect(find.text('The PDF could not be saved.'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 101));
    await _exit(tester);
    expect(_cards, findsNothing);
  });

  testWidgets('holding the card pauses the countdown', (tester) async {
    final context = await _mount(tester);
    ScheduleToast.show(
      context,
      'Offer accepted.',
      kind: ScheduleMessageKind.success,
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    final gesture = await tester.startGesture(
      tester.getCenter(find.text('Offer accepted.')),
    );
    final held = _fill(tester);
    await tester.pump(const Duration(seconds: 10));
    expect(find.text('Offer accepted.'), findsOneWidget);
    expect(_fill(tester), closeTo(held, .001));
    await gesture.up();
    await tester.pumpAndSettle();
    expect(_cards, findsNothing);
  });

  testWidgets('at most three on screen; the rest queue in order', (
    tester,
  ) async {
    final context = await _mount(tester);
    for (var i = 1; i <= 5; i++) {
      expect(ScheduleToast.show(context, 'Message $i'), isTrue);
    }
    await tester.pump();
    await tester.pump(ScheduleToast.appearDuration);
    expect(_cards, findsNWidgets(ScheduleToast.maxVisible));
    expect(find.text('Message 4'), findsNothing);
    // Newer toasts stack below older ones, all at the top of the screen.
    expect(
      tester.getTopLeft(find.text('Message 1')).dy,
      lessThan(tester.getTopLeft(find.text('Message 2')).dy),
    );
    await tester.tap(
      find.byKey(const ValueKey('schedule-toast-dismiss')).first,
    );
    await _exit(tester);
    expect(find.text('Message 1'), findsNothing);
    expect(find.text('Message 4'), findsOneWidget);
    expect(_cards, findsNWidgets(3));
    await tester.pumpAndSettle();
    expect(_cards, findsNothing);
  });

  testWidgets('an identical message and kind is not stacked twice', (
    tester,
  ) async {
    final context = await _mount(tester);
    expect(
      ScheduleToast.show(
        context,
        'Connection lost.',
        kind: ScheduleMessageKind.error,
      ),
      isTrue,
    );
    expect(
      ScheduleToast.show(
        context,
        'Connection lost.',
        kind: ScheduleMessageKind.error,
      ),
      isFalse,
    );
    // Same text, different meaning: still shown.
    expect(
      ScheduleToast.show(
        context,
        'Connection lost.',
        kind: ScheduleMessageKind.info,
      ),
      isTrue,
    );
    expect(ScheduleToast.show(context, '   '), isFalse);
    await tester.pump();
    expect(_cards, findsNWidgets(2));
    await tester.pumpAndSettle();
    // Once gone, the same message can be shown again.
    expect(
      ScheduleToast.show(
        context,
        'Connection lost.',
        kind: ScheduleMessageKind.error,
      ),
      isTrue,
    );
    await tester.pumpAndSettle();
  });

  testWidgets('long text wraps at 320dp with 2x text, no overflow', (
    tester,
  ) async {
    final context = await _mount(
      tester,
      size: const Size(320, 640),
      textScale: 2,
    );
    const message =
        'The clock-out cannot be recorded until the shift has ended. Ask your venue manager to record it as a correction.';
    ScheduleToast.show(context, message, kind: ScheduleMessageKind.warning);
    await tester.pump();
    await tester.pump(ScheduleToast.appearDuration);
    expect(tester.takeException(), isNull);
    final card = tester.getRect(_cards);
    expect(card.left, greaterThanOrEqualTo(16));
    expect(card.right, lessThanOrEqualTo(320 - 16));
    final text = tester.getRect(find.text(message));
    expect(text.height, greaterThan(4 * 14.5 * 2)); // several wrapped lines
    expect(find.text(message), findsOneWidget);
    await tester.pumpAndSettle();
  });

  testWidgets(
    'reduced motion: no slide or fade, fill held still, still dismisses',
    (tester) async {
      final context = await _mount(tester, reduced: true);
      ScheduleToast.show(
        context,
        'Review saved.',
        kind: ScheduleMessageKind.success,
      );
      await tester.pump();
      expect(
        find.ancestor(of: _cards, matching: find.byType(SlideTransition)),
        findsNothing,
      );
      expect(
        find.ancestor(of: _cards, matching: find.byType(FadeTransition)),
        findsNothing,
      );
      await tester.pump(const Duration(seconds: 3));
      expect(_fill(tester), 1);
      // No animation is running, so nothing schedules frames while it waits.
      expect(tester.binding.hasScheduledFrame, isFalse);
      await tester.pump(const Duration(milliseconds: 1600));
      expect(_cards, findsNothing);
    },
  );

  testWidgets('sits at the top, above a modal sheet, clear of bottom actions', (
    tester,
  ) async {
    final context = await _mount(
      tester,
      body: Align(
        alignment: Alignment.bottomCenter,
        child: ScheduleBottomAction(
          child: SchedulePrimaryButton(label: 'Clock Out', onPressed: () {}),
        ),
      ),
    );
    showScheduleSheet<void>(
      context: context,
      builder: (_) => const Text('End your shift?'),
    );
    await tester.pumpAndSettle();
    ScheduleToast.show(
      context,
      'Attendance reviewed.',
      kind: ScheduleMessageKind.success,
    );
    await tester.pump();
    await tester.pump(ScheduleToast.appearDuration);
    // Hit-testable above the sheet's barrier.
    expect(find.text('Attendance reviewed.').hitTestable(), findsOneWidget);
    final toast = tester.getRect(_cards);
    expect(
      toast.bottom,
      lessThan(tester.getRect(find.text('End your shift?')).top),
    );
    expect(toast.bottom, lessThan(tester.getRect(find.text('Clock Out')).top));
    await tester.pumpAndSettle();
  });

  testWidgets(
    'survives a route pop; tearing the app down leaves no timers or entries',
    (tester) async {
      final context = await _mount(tester);
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('Details')),
        ),
      );
      await tester.pumpAndSettle();
      ScheduleToast.show(tester.element(find.text('Details')), 'Review saved.');
      Navigator.of(tester.element(find.text('Details'))).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Review saved.'), findsOneWidget);
      // Overlay disposed while toasts are mid-countdown (one animated, one queued).
      for (var i = 0; i < 4; i++) {
        ScheduleToast.show(context, 'Queued $i');
      }
      await tester.pumpWidget(const SizedBox());
      expect(_cards, findsNothing);
      expect(tester.takeException(), isNull);
      // A fresh app gets a fresh controller.
      final next = await _mount(tester, reduced: true);
      expect(ScheduleToast.show(next, 'Review saved.'), isTrue);
      await tester.pump();
      expect(_cards, findsOneWidget);
      ScheduleToast.dismissAll(next);
      await tester.pump();
      expect(_cards, findsNothing);
      // flutter_test fails the test if any Timer is still pending at the end.
    },
  );

  testWidgets('variants and stacked state render (golden + screenshots)', (
    tester,
  ) async {
    final boundary = GlobalKey();
    tester.view.physicalSize = const Size(393, 520);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    Widget card(String message, ScheduleMessageKind kind, double remaining) =>
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: ScheduleToastCard(
            message: message,
            kind: kind,
            remaining: remaining,
          ),
        );
    await tester.pumpWidget(
      MaterialApp(
        theme: buildLightTheme(),
        home: Scaffold(
          body: RepaintBoundary(
            key: boundary,
            child: ColoredBox(
              color: ScheduleTokens.background,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    card(
                      'Unable to update this staff member. Please try again.',
                      ScheduleMessageKind.error,
                      .7,
                    ),
                    card('Review saved.', ScheduleMessageKind.success, .45),
                    card(
                      'Some offers failed. Check Sent Shifts.',
                      ScheduleMessageKind.warning,
                      .85,
                    ),
                    card(
                      'Choose where to save timesheet.pdf',
                      ScheduleMessageKind.info,
                      .25,
                    ),
                    card(ApiMessages.offline, ScheduleMessageKind.error, 1),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await expectLater(
      find.byKey(boundary),
      matchesGoldenFile('goldens/toast-variants.png'),
    );
    if (_captureDir.isNotEmpty) {
      await _save(tester, boundary, 'flutter-variants');
    }

    // Live stacked state on the root overlay over a real screen.
    final context = await _mount(
      tester,
      appBoundary: boundary,
      body: Align(
        alignment: Alignment.bottomCenter,
        child: ScheduleBottomAction(
          child: SchedulePrimaryButton(label: 'Clock Out', onPressed: () {}),
        ),
      ),
    );
    ScheduleToast.show(
      context,
      'Attendance reviewed.',
      kind: ScheduleMessageKind.success,
    );
    ScheduleToast.show(
      context,
      ApiMessages.offline,
      kind: ScheduleMessageKind.error,
    );
    ScheduleToast.show(context, 'Choose where to save timesheet.pdf');
    ScheduleToast.show(context, 'Queued message');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 1500));
    if (_captureDir.isNotEmpty) {
      await _save(tester, boundary, 'flutter-stacked');
      for (final kind in ScheduleMessageKind.values) {
        await tester.pumpWidget(
          MaterialApp(
            theme: buildLightTheme(),
            home: Scaffold(
              body: RepaintBoundary(
                key: boundary,
                child: ColoredBox(
                  color: ScheduleTokens.background,
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Align(
                      alignment: Alignment.topCenter,
                      child: ScheduleToastCard(
                        message: switch (kind) {
                          ScheduleMessageKind.error => ApiMessages.offline,
                          ScheduleMessageKind.success => 'Review saved.',
                          ScheduleMessageKind.warning =>
                            'Some offers failed. Check Sent Shifts.',
                          ScheduleMessageKind.info =>
                            'Choose where to save timesheet.pdf',
                        },
                        kind: kind,
                        remaining: .6,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        await _save(tester, boundary, 'flutter-${kind.name}');
      }
    } else {
      await tester.pumpAndSettle();
    }
  });

  group('API error text', () {
    String msg(int status, String message) =>
        ApiException(status, message).userMessage;
    test('status defaults when the server text is technical or absent', () {
      expect(msg(401, 'Unauthorized'), ApiMessages.sessionExpired);
      expect(msg(403, 'Forbidden resource'), ApiMessages.forbidden);
      expect(msg(404, 'Not Found'), ApiMessages.notFound);
      expect(msg(409, 'Conflict'), ApiMessages.conflict);
      expect(msg(500, 'Shift not found.'), ApiMessages.serverError);
      expect(msg(502, 'Bad Gateway'), ApiMessages.serverError);
      expect(
        msg(400, 'property organisationId should not exist'),
        ApiMessages.serverError,
      );
      expect(
        msg(400, 'clockOutAt cannot be before clockInAt.'),
        ApiMessages.serverError,
      );
      expect(msg(400, 'shift_mismatch'), ApiMessages.serverError);
      expect(
        msg(500, 'QueryFailedError: relation "x" does not exist'),
        ApiMessages.serverError,
      );
      expect(msg(0, ''), ApiMessages.offline);
    });
    test('user-facing domain messages are kept', () {
      expect(
        msg(409, 'This shift is not confirmed for you.'),
        'This shift is not confirmed for you.',
      );
      expect(
        msg(400, 'Too early to clock in — this shift starts at 09:00.'),
        'Too early to clock in — this shift starts at 09:00.',
      );
      expect(msg(404, 'Attendance not found.'), 'Attendance not found.');
      expect(
        msg(429, 'Too many requests. Please try again in 2 minutes.'),
        'Too many requests. Please try again in 2 minutes.',
      );
      expect(
        msg(
          401,
          'Your session changed while this was loading. Please try again.',
        ),
        'Your session changed while this was loading. Please try again.',
      );
    });
    test('connectivity failures read as a lost connection', () {
      expect(
        userMessageFor(const SocketException('Failed host lookup')),
        ApiMessages.offline,
      );
      expect(
        userMessageFor(http.ClientException('Connection closed')),
        ApiMessages.offline,
      );
      expect(
        userMessageFor(StateError('x'), fallback: 'Could not load.'),
        'Could not load.',
      );
      expect(userMessageFor(StateError('x')), ApiMessages.serverError);
    });
  });
}

Future<void> _save(WidgetTester tester, GlobalKey boundary, String name) async {
  final render =
      boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  await tester.runAsync(() async {
    final image = await render.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(_captureDir).create(recursive: true);
    await File(
      '$_captureDir/$name.png',
    ).writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}
