import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/core/theme/money.dart';

/// The money-display table shared with the web (`@rab/shared` formatPence)
/// and the iPhone app. `flutter test` runs from packages/rab-mobile.
const _sharedCasesPath = '../rab-shared/src/utils/money-format-cases.json';

List<({int pence, String text})> _sharedCases() {
  final file = File(_sharedCasesPath);
  final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  return [
    for (final c in json['cases'] as List<dynamic>)
      (
        pence: (c as Map<String, dynamic>)['pence'] as int,
        text: c['text'] as String,
      ),
  ];
}

void main() {
  group('formatPence', () {
    test('prints every shared case exactly like the web', () {
      final cases = _sharedCases();
      expect(cases.length, greaterThan(20));
      for (final c in cases) {
        expect(formatPence(c.pence), c.text, reason: 'pence ${c.pence}');
      }
    });

    test('the owner-named cases (en-GB Intl.NumberFormat currency)', () {
      expect(formatPence(0), '£0.00');
      expect(formatPence(-1), '-£0.01');
      expect(formatPence(-150), '-£1.50');
      expect(formatPence(-199), '-£1.99');
      expect(formatPence(123450), '£1,234.50');
      expect(formatPence(-123450), '-£1,234.50');
      expect(formatPence(123456), '£1,234.56');
      expect(formatPence(-123456), '-£1,234.56');
    });

    // Beyond the web's safe-integer range: the most negative 64-bit int, where
    // `int.abs()` overflows.
    test('the most negative int keeps its sign and digits', () {
      expect(
        formatPence(-9223372036854775807 - 1),
        '-£92,233,720,368,547,758.08',
      );
      expect(formatPence(9223372036854775807), '£92,233,720,368,547,758.07');
    });

    test('rate and estimate labels', () {
      expect(payRateLabel(0), 'Rate not set');
      expect(payRateLabel(-1), 'Rate not set');
      expect(payRateLabel(1150), '£11.50/h');
      expect(payRateLabel(250000), '£2,500.00/h');
      expect(estimatedPayLabel(0, 9000), 'Estimated pay unavailable');
      expect(estimatedPayLabel(1200, 9000), '£90.00 estimated pay');
      expect(estimatedPayLabel(1200, 123456), '£1,234.56 estimated pay');
    });
  });
}
