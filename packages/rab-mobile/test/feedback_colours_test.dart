import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/theme/schedule_tokens.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/schedule_feedback.dart';

void main() {
  for (final dark in [false, true]) {
    for (final kind in ScheduleMessageKind.values) {
      testWidgets(
        '$kind feedback in dark=$dark preserves headings and actions',
        (tester) async {
          var pressed = false;
          await tester.pumpWidget(
            MaterialApp(
              theme: dark ? buildDarkTheme() : buildLightTheme(),
              home: Scaffold(
                body: Column(
                  children: [
                    const Text('Page heading', style: ScheduleTokens.heading),
                    ScheduleMessageCard(
                      title: 'Operation result',
                      message: 'Feedback details',
                      kind: kind,
                      actionLabel: 'Continue',
                      onAction: () => pressed = true,
                    ),
                  ],
                ),
              ),
            ),
          );
          final expected = switch (kind) {
            ScheduleMessageKind.error => ScheduleTokens.errorText,
            ScheduleMessageKind.success => ScheduleTokens.successText,
            ScheduleMessageKind.warning => AppColorsX.light.warning,
            ScheduleMessageKind.info => ScheduleTokens.ink,
          };
          final title = tester.widget<Text>(find.text('Operation result'));
          expect(
            title.style,
            ScheduleTokens.body.copyWith(fontWeight: FontWeight.w600),
          );
          expect(
            tester.widget<Text>(find.text('Page heading')).style,
            ScheduleTokens.heading,
          );
          expect(
            tester.widget<Text>(find.text('Feedback details')).style,
            ScheduleTokens.body.copyWith(color: expected),
          );
          final button = tester.widget<FilledButton>(find.byType(FilledButton));
          expect(
            button.style!.backgroundColor!.resolve({}),
            ScheduleTokens.accent,
          );
          expect(button.style!.foregroundColor!.resolve({}), Colors.white);
          if (kind == ScheduleMessageKind.error) {
            expect(
              find.byWidgetPredicate(
                (widget) =>
                    widget is Semantics && widget.properties.liveRegion == true,
              ),
              findsOneWidget,
            );
          }
          await tester.tap(find.text('Continue'));
          expect(pressed, isTrue);
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  testWidgets('a bodyless inline error is still feedback, not a page heading', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildLightTheme(),
        home: const Scaffold(
          body: ScheduleMessageCard(
            title: 'Could not load your shifts.',
            kind: ScheduleMessageKind.error,
          ),
        ),
      ),
    );
    expect(
      tester
          .widget<Text>(find.text('Could not load your shifts.'))
          .style!
          .color,
      ScheduleTokens.errorText,
    );
  });
}
