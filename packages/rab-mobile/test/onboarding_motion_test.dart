import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/features/welcome/welcome_header.dart';
import 'package:rab_staff/features/welcome/onboarding_page.dart';

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

  Future<PageController> open(
    WidgetTester tester, {
    bool reduced = false,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(393, 851);
    addTearDown(tester.view.reset);
    addTearDown(() async => tester.pumpWidget(const SizedBox.shrink()));
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(
            size: const Size(393, 851),
            disableAnimations: reduced,
          ),
          child: Scaffold(body: WelcomeOnboarding(onGetStarted: () {})),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return tester.widget<PageView>(find.byType(PageView)).controller!;
  }

  testWidgets('four-second cadence, 650ms transition, seamless 3 to 1 loop', (
    tester,
  ) async {
    final pages = await open(tester);
    expect(pages.viewportFraction, 1);
    for (var i = 1; i <= 3; i++) {
      // Entrance has already consumed some of the first hold; subsequent holds
      // begin only after the preceding scroll settles.
      await tester.pump(const Duration(milliseconds: 3350));
      await tester.pump(const Duration(milliseconds: 325));
      expect(pages.page!, greaterThan(2999 + i));
      expect(pages.page!, lessThan(3000 + i));
      await tester.pumpAndSettle();
      expect(pages.page, (3000 + i).toDouble());
      expect(
        find.bySemanticsLabel('Onboarding page ${i % 3 + 1} of 3'),
        findsOneWidget,
      );
    }
  });

  testWidgets(
    'holding and dragging pauses auto movement; settling restarts hold',
    (tester) async {
      final pages = await open(tester);
      final gesture = await tester.startGesture(
        tester.getCenter(find.byType(PageView)),
      );
      await tester.pump(const Duration(seconds: 8));
      expect(pages.page, 3000);
      await gesture.moveBy(const Offset(-280, 0));
      await tester.pump(const Duration(milliseconds: 100));
      await gesture.up();
      await tester.pumpAndSettle();
      expect(pages.page, 3001);
      await tester.pump(const Duration(milliseconds: 2800));
      expect(pages.page, 3001);
      await tester.pump(const Duration(milliseconds: 550));
      await tester.pumpAndSettle();
      expect(pages.page, 3002);
    },
  );

  testWidgets(
    'each animated page is clipped at its own full viewport boundary',
    (tester) async {
      await open(tester);
      final pageView = tester.widget<PageView>(find.byType(PageView));
      expect(pageView.clipBehavior, Clip.hardEdge);
      for (final page in tester.elementList(find.byType(OnboardingPage))) {
        final clip = page.findAncestorWidgetOfExactType<ClipRect>();
        expect(clip, isNotNull);
        expect(clip!.clipBehavior, Clip.hardEdge);
        expect(tester.getSize(find.byWidget(page.widget)).width, 393);
      }
    },
  );

  testWidgets(
    'reduced motion disables automatic movement; manual controls work',
    (tester) async {
      final pages = await open(tester, reduced: true);
      await tester.pump(const Duration(seconds: 30));
      expect(pages.page, 3000);
      await tester.tap(find.byTooltip('Hospitality'));
      await tester.pumpAndSettle();
      expect(pages.page, 3001);
    },
  );

  testWidgets(
    'indicator has exact compact dimensions without moving page geometry',
    (tester) async {
      await open(tester);
      for (var selected = 0; selected < 3; selected++) {
        await tester.tap(
          find.byTooltip(['Welcome', 'Hospitality', 'Opportunities'][selected]),
        );
        await tester.pumpAndSettle();
        final rects = List.generate(
          3,
          (i) =>
              tester.getRect(find.byKey(ValueKey('onboarding-indicator-$i'))),
        );
        for (var i = 0; i < 3; i++) {
          expect(
            rects[i].size,
            i == selected ? const Size(18, 3) : const Size(4, 4),
          );
          if (i > 0) expect(rects[i].left - rects[i - 1].right, 8);
        }
        expect(rects.last.right - rects.first.left, 42);
        expect(rects.last.right, 361);
        expect(
          tester.getRect(find.byType(PageView)),
          const Rect.fromLTRB(0, 48, 393, 735),
        );
        expect(tester.getTopLeft(find.text('ADOLPHUS / RECRUITMENT')).dx, 24);
      }
    },
  );

  testWidgets('3350ms idle plus 650ms movement is a single four-second cycle', (
    tester,
  ) async {
    final pages = await open(tester);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 3349));
    expect(pages.page, 3000);
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump(const Duration(milliseconds: 325));
    expect(
      pages.page!,
      closeTo(3000 + Curves.easeInOutCubic.transform(.5), .001),
    );
    await tester.pump(const Duration(milliseconds: 325));
    expect(pages.page, 3001);
    await tester.pumpAndSettle();
  });

  testWidgets('background pauses timer and resume starts a fresh hold', (
    tester,
  ) async {
    final pages = await open(tester);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 20));
    expect(pages.page, 3000);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump(const Duration(milliseconds: 3250));
    expect(pages.page, 3000);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pumpAndSettle();
    expect(pages.page, 3001);
  });
}
