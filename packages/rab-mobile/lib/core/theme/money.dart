/// Mirrors `formatPence` in `packages/rab-shared/src/utils/money.ts` — pence
/// is always an integer, formatted here rather than converted to a float.
///
/// The sign comes from `pence` itself; pounds and pence are formatted from the
/// magnitude. (Splitting the signed value lost the sign under £1, because `~/`
/// truncates, and `%` is Euclidean in Dart, so -199 printed "£-1.01".) The
/// sign keeps this app's position, "£-1.50" (the web prints "-£1.50").
String formatPence(int pence) {
  final sign = pence < 0 ? '-' : '';
  final magnitude = pence.abs();
  final pounds = magnitude ~/ 100;
  final remainder = (magnitude % 100).toString().padLeft(2, '0');
  return '£$sign$pounds.$remainder';
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
