import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/motion/shift_motion.dart';
import 'package:rab_staff/features/venue_manager/report_ui.dart';
import 'package:rab_staff/core/widgets/schedule_feedback.dart';
import 'package:rab_staff/core/widgets/shift_countdown_panel.dart';

void main() {
  testWidgets(
    'report selection keeps one highlight and disabled actions do nothing',
    (tester) async {
      var selected = 0;
      Future<void> mount(bool enabled, bool reduced) => tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(disableAnimations: reduced),
            child: Scaffold(
              body: ReportSegments<int>(
                values: const [0, 1],
                labels: const ['Attendance', 'Hours'],
                selected: selected,
                onChanged: enabled ? (value) => selected = value : null,
              ),
            ),
          ),
        ),
      );
      await mount(true, false);
      await tester.tap(find.text('Hours'));
      expect(selected, 1);
      await mount(false, true);
      await tester.tap(find.text('Attendance'));
      expect(selected, 1);
      expect(find.byType(AnimatedAlign), findsOneWidget);
      expect(
        tester.widget<AnimatedAlign>(find.byType(AnimatedAlign)).duration,
        Duration.zero,
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'page transition removes outgoing controls from focus and semantics',
    (tester) async {
      Future<void> mount(String page, {bool reduced = false}) =>
          tester.pumpWidget(
            MaterialApp(
              home: MediaQuery(
                data: MediaQueryData(disableAnimations: reduced),
                child: Scaffold(
                  body: MotionContent(
                    identity: page,
                    child: TextButton(onPressed: () {}, child: Text(page)),
                  ),
                ),
              ),
            ),
          );
      await mount('Organization');
      await mount('My Space');
      await tester.pump(const Duration(milliseconds: 50));
      expect(
        find.ancestor(
          of: find.text('Organization'),
          matching: find.byType(IgnorePointer),
        ),
        findsWidgets,
      );
      expect(
        find.ancestor(
          of: find.text('Organization'),
          matching: find.byType(ExcludeSemantics),
        ),
        findsWidgets,
      );
      expect(
        find.ancestor(
          of: find.text('Organization'),
          matching: find.byType(ExcludeFocus),
        ),
        findsWidgets,
      );
      await tester.pumpAndSettle();
      expect(find.text('Organization'), findsNothing);
      await mount('Organization', reduced: true);
      await tester.pump();
      expect(find.text('My Space'), findsNothing);
      expect(find.text('Organization'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'press feedback never activates a disabled action or duplicates a tap',
    (tester) async {
      var calls = 0;
      Future<void> mount(bool busy) => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SchedulePrimaryButton(
              label: 'Save',
              busy: busy,
              onPressed: () => calls++,
            ),
          ),
        ),
      );
      await mount(true);
      await tester.tap(find.byType(FilledButton));
      expect(calls, 0);
      await mount(false);
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();
      expect(calls, 1);
    },
  );

  testWidgets(
    'countdown rolls only supplied time and settles immediately with reduced motion',
    (tester) async {
      Future<void> mount(int? seconds, bool reduced) => tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(disableAnimations: reduced),
            child: Scaffold(
              body: ShiftCountdownPanel(
                heading: 'Time on shift',
                seconds: seconds,
              ),
            ),
          ),
        ),
      );
      await mount(61, false);
      await mount(60, false);
      await tester.pumpAndSettle();
      expect(find.text('00'), findsNWidgets(2));
      expect(find.text('01'), findsOneWidget);
      await tester.pump(const Duration(seconds: 5));
      expect(find.text('01'), findsOneWidget); // No invented local timer.
      await mount(59, true);
      await tester.pump();
      expect(find.text('59'), findsOneWidget);
      expect(tester.binding.hasScheduledFrame, isFalse);
      await mount(null, true);
      expect(find.text('—'), findsOneWidget);
      expect(find.text('59'), findsNothing);
    },
  );
}
