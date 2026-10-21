/// Mirrors `formatPence` in `packages/rab-shared/src/utils/money.ts` — pence
/// is always an integer, formatted here rather than converted to a float.
String formatPence(int pence) {
  final pounds = pence ~/ 100;
  final remainder = (pence % 100).abs().toString().padLeft(2, '0');
  return '£$pounds.$remainder';
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
