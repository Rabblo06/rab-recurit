/// Mirrors `formatPence` in `packages/rab-shared/src/utils/money.ts`, which
/// prints the en-GB GBP currency format of `Intl.NumberFormat`: the sign
/// before the pound sign, comma thousands separators, two decimals
/// (`-£1,234.56`). Owner decision: the phone apps print money exactly like
/// the website. The cases are shared with the web and the iPhone app in
/// `packages/rab-shared/src/utils/money-format-cases.json`.
///
/// Pence is always an integer, formatted with integer arithmetic rather than
/// converted to a float. Pounds and pence come from truncating division and
/// `remainder` (both round toward zero) and are then made positive, so the
/// sign is taken from `pence` alone and even the most negative int prints
/// correctly (`int.abs()` would overflow there).
String formatPence(int pence) {
  final sign = pence < 0 ? '-' : '';
  final pounds = (pence ~/ 100).abs().toString();
  final remainder = pence.remainder(100).abs().toString().padLeft(2, '0');
  return '$sign£${_groupThousands(pounds)}.$remainder';
}

/// "1234567" → "1,234,567".
String _groupThousands(String digits) {
  final buffer = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
    buffer.write(digits[i]);
  }
  return buffer.toString();
}

/// Hourly rate label. ASSUMPTION (display only, flagged to the owner): a rate
/// of 0 pence means no rate has been configured for the shift, so it reads
/// "Rate not set" instead of a misleading "£0.00/h". Calculation is unchanged
/// and stays server-side.
String payRateLabel(int pence) =>
    pence > 0 ? '${formatPence(pence)}/h' : 'Rate not set';

/// Estimated pay label; unavailable while no rate is configured.
String estimatedPayLabel(int ratePence, int estimatedPence) => ratePence > 0
    ? '${formatPence(estimatedPence)} estimated pay'
    : 'Estimated pay unavailable';
