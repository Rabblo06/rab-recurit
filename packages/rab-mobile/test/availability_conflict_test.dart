import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/features/venue_manager/availability_conflict.dart';

ApiException conflictError({int total = 1, List<Map<String, dynamic>>? conflicts, int unknown = 0}) => ApiException(
  409,
  'John Smith has marked themselves as unavailable on Monday.',
  body: {
    'code': 'STAFF_AVAILABILITY_CONFLICT',
    'totalRecipients': total,
    'conflicts': conflicts ??
        [
          {
            'staffProfileId': 's-john',
            'staffName': 'John Smith',
            'availableDays': ['Tuesday', 'Sunday'],
            'conflictDates': [
              {'date': '2026-10-19', 'weekday': 'Monday'},
            ],
          },
        ],
    'unknownAvailability': [for (var i = 0; i < unknown; i++) {'staffProfileId': 'u$i', 'staffName': 'U$i'}],
  },
);

void main() {
  test('parses only the typed 409 and builds date-specific acknowledgements', () {
    final conflict = AvailabilityConflict.fromError(conflictError())!;
    expect(conflict.entries.single.staffName, 'John Smith');
    expect(conflict.acknowledgements, [
      {'staffProfileId': 's-john', 'dates': ['2026-10-19']},
    ]);
    expect(AvailabilityConflict.fromError(ApiException(409, 'other', body: {'code': 'OTHER'})), isNull);
    expect(AvailabilityConflict.fromError(ApiException(400, 'bad', body: {'code': 'STAFF_AVAILABILITY_CONFLICT'})), isNull);
    expect(AvailabilityConflict.fromError(Exception('network')), isNull);
  });

  test('formats declared days in calendar order', () {
    expect(formatWeekdayList(['Sunday', 'Tuesday']), 'Tuesday and Sunday');
    expect(formatWeekdayList(['Friday', 'Monday', 'Wednesday']), 'Monday, Wednesday and Friday');
  });

  for (final choice in ['Cancel', 'Submit anyway']) {
    testWidgets('sheet returns ${choice == 'Cancel' ? 'false' : 'true'} on $choice', (tester) async {
      bool? result;
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async => result = await confirmAvailabilityConflict(context, AvailabilityConflict.fromError(conflictError())!),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Staff availability warning'), findsOneWidget);
      expect(find.text('John Smith has marked themselves as unavailable on Monday.'), findsOneWidget);
      expect(find.text('Available days: Tuesday and Sunday.'), findsOneWidget);
      await tester.tap(find.text(choice));
      await tester.pumpAndSettle();
      expect(result, choice == 'Submit anyway');
    });
  }

  testWidgets('bulk sheet shows the N of M summary and unknown availability note', (tester) async {
    final error = conflictError(total: 10, unknown: 1, conflicts: [
      for (final name in ['John Smith', 'Amy Lee', 'Bo Chan'])
        {
          'staffProfileId': name,
          'staffName': name,
          'availableDays': ['Saturday'],
          'conflictDates': [
            {'date': '2026-10-19', 'weekday': 'Monday'},
          ],
        },
    ]);
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(onPressed: () => confirmAvailabilityConflict(context, AvailabilityConflict.fromError(error)!), child: const Text('open')),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('3 of 10 selected Staff have availability conflicts.'), findsOneWidget);
    expect(find.textContaining('1 selected person has not provided availability'), findsOneWidget);
  });
}
