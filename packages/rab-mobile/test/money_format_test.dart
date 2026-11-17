import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/core/theme/money.dart';

void main() {
  group('formatPence', () {
    test(
      'formats positive amounts as £<pounds>.<pp> with no thousands separator',
      () {
        expect(formatPence(0), '£0.00');
        expect(formatPence(5), '£0.05');
        expect(formatPence(1250), '£12.50');
        expect(formatPence(123456), '£1234.56');
      },
    );

    // Dart `~/` truncates and `%` is Euclidean: splitting the signed value lost the sign under £1 (-50 → "£0.50")
    // and printed -199 as "£-1.01".
    test('keeps the sign and the right pence for negative amounts', () {
      expect(formatPence(-1), '£-0.01');
      expect(formatPence(-5), '£-0.05');
      expect(formatPence(-50), '£-0.50');
      expect(formatPence(-99), '£-0.99');
      expect(formatPence(-100), '£-1.00');
      expect(formatPence(-150), '£-1.50');
      expect(formatPence(-199), '£-1.99');
      expect(formatPence(-123456), '£-1234.56');
    });

    test('rate and estimate labels are unchanged', () {
      expect(payRateLabel(0), 'Rate not set');
      expect(payRateLabel(-1), 'Rate not set');
      expect(payRateLabel(1150), '£11.50/h');
      expect(estimatedPayLabel(0, 9000), 'Estimated pay unavailable');
      expect(estimatedPayLabel(1200, 9000), '£90.00 estimated pay');
    });
  });
}
