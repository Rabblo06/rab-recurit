import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/widgets/schedule_toast.dart';
import 'package:rab_staff/features/security/widgets/security_kit.dart';

void main() {
  testWidgets('security feedback uses the shared deduplicating toast overlay', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) {
              return TextButton(
                onPressed: () => showSecuritySnack(context, 'Setup key copied'),
                child: const Text('Copy'),
              );
            },
          ),
        ),
      ),
    );
    await tester.tap(find.text('Copy'));
    await tester.pump();
    await tester.tap(find.text('Copy'));
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.byType(SnackBar), findsNothing);
    expect(find.byType(ScheduleToastCard), findsOneWidget);
    expect(find.text('Setup key copied'), findsOneWidget);
    expect(find.byKey(const ValueKey('schedule-toast-dismiss')), findsNothing);
    await tester.pump(ScheduleToast.shortDuration);
    await tester.pumpAndSettle();
    expect(find.byType(ScheduleToastCard), findsNothing);
  });
}
