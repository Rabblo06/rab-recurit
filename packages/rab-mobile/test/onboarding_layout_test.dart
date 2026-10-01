import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/features/welcome/welcome_header.dart';

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

  for (final size in [
    const Size(320, 568),
    const Size(393, 851),
    const Size(393, 852),
    const Size(430, 932),
    const Size(768, 1024),
    const Size(844, 390),
  ]) {
    for (final textScale in [1.0, 1.25, 2.0]) {
      testWidgets('three pages at $size, text $textScale', (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = size;
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);
        var completions = 0;
        await tester.pumpWidget(
          MaterialApp(
            home: MediaQuery(
              data: MediaQueryData(
                size: size,
                padding: const EdgeInsets.only(top: 44, bottom: 34),
                textScaler: TextScaler.linear(textScale),
                disableAnimations: textScale == 2,
              ),
              child: Scaffold(
                body: WelcomeOnboarding(onGetStarted: () => completions++),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        for (var page = 0; page < 3; page++) {
          if (page > 0) {
            final width = tester.getSize(find.byType(PageView)).width;
            await tester.drag(find.byType(PageView), Offset(-width * .8, 0));
            await tester.pumpAndSettle();
          }
          expect(
            find.bySemanticsLabel('Onboarding page ${page + 1} of 3'),
            findsOneWidget,
          );
          expect(tester.takeException(), isNull);
          await tester.tap(find.text('Get Started'));
          await tester.pumpAndSettle();
          expect(completions, page + 1);
        }
        await tester.tap(find.byTooltip('Welcome'));
        await tester.pumpAndSettle();
        expect(find.bySemanticsLabel('Onboarding page 1 of 3'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }
}
