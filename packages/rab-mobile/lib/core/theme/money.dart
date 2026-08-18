/// Mirrors `formatPence` in `packages/rab-shared/src/utils/money.ts` — pence
/// is always an integer, formatted here rather than converted to a float.
String formatPence(int pence) {
  final pounds = pence ~/ 100;
  final remainder = (pence % 100).abs().toString().padLeft(2, '0');
  return '£$pounds.$remainder';
}
