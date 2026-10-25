import 'package:flutter/material.dart';

import '../security_tokens.dart';
import 'security_icon.dart';

/// `codeList()` on the phone: a white panel of tabular codes. Real codes are
/// `XXXX-XXXX-XXXX-XXXX` (19 characters, not the design's 9-character
/// samples), so the grid measures them: two columns (the design) when the
/// widest code fits a column at 13px, or at no less than 85% of that; one
/// column otherwise (narrow phones with large text). Never clipped or wrapped
/// mid-code.
class RecoveryCodeGrid extends StatelessWidget {
  const RecoveryCodeGrid({super.key, required this.codes});
  final List<String> codes;

  static const _style = TextStyle(
    fontSize: 13,
    height: 1.5,
    color: SecurityTokens.ink,
    fontFeatures: [FontFeature.tabularFigures()],
  );
  static const _columnGap = 16.0;
  static const _rowGap = 14.0;
  static const _minScale = .85;

  @override
  Widget build(BuildContext context) {
    final scaler = MediaQuery.textScalerOf(context);
    // Measure with exactly what the Text widgets will inherit (font family).
    final base = DefaultTextStyle.of(context).style.merge(_style);
    return Semantics(
      label: 'Recovery codes, ${codes.length}',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
        decoration: BoxDecoration(
          color: SecurityTokens.surface,
          borderRadius: BorderRadius.circular(12),
        ),
        child: LayoutBuilder(
          builder: (context, constraints) {
            var widest = 0.0;
            for (final code in codes) {
              final painter = TextPainter(
                text: TextSpan(text: code, style: base),
                textDirection: TextDirection.ltr,
                textScaler: scaler,
                maxLines: 1,
              )..layout();
              if (painter.width > widest) widest = painter.width;
              painter.dispose();
            }
            final column = (constraints.maxWidth - _columnGap) / 2;
            final scale = widest <= 0 ? 1.0 : (column / widest).clamp(0.0, 1.0);
            final twoColumns = scale >= _minScale;
            final perRow = twoColumns ? 2 : 1;
            final style = twoColumns && scale < 1
                ? base.copyWith(
                    fontSize:
                        (base.fontSize! * scale * 10).floorToDouble() / 10,
                  )
                : base;
            final rows = <Widget>[];
            for (var i = 0; i < codes.length; i += perRow) {
              if (i > 0) rows.add(const SizedBox(height: _rowGap));
              rows.add(
                Row(
                  children: [
                    for (var j = 0; j < perRow; j++) ...[
                      if (j > 0) const SizedBox(width: _columnGap),
                      Expanded(
                        child: i + j < codes.length
                            ? Text(
                                codes[i + j],
                                maxLines: 1,
                                softWrap: false,
                                style: style,
                              )
                            : const SizedBox.shrink(),
                      ),
                    ],
                  ],
                ),
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: rows,
            );
          },
        ),
      ),
    );
  }
}

/// `keyBox()` on the phone: "Setup key" label, a white box with the grouped
/// key (it wraps to two lines: real keys are 8 groups) and a copy control.
class SetupKeyBox extends StatelessWidget {
  const SetupKeyBox({super.key, required this.manualKey, required this.onCopy});
  final String manualKey;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Text('Setup key', style: SecurityType.label),
      const SizedBox(height: 8),
      Container(
        padding: const EdgeInsets.fromLTRB(14, 6, 4, 6),
        decoration: BoxDecoration(
          color: SecurityTokens.surface,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Text(
                  manualKey,
                  style: const TextStyle(
                    fontSize: 12,
                    height: 1.6,
                    fontWeight: FontWeight.w500,
                    letterSpacing: .25,
                    // The design's key inherits `.field`'s muted colour (4.5:1 on white).
                    color: SecurityTokens.muted,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              ),
            ),
            IconButton(
              tooltip: 'Copy setup key',
              onPressed: onCopy,
              icon: const SecurityIcon(
                SecurityGlyph.copy,
                size: 16,
                color: SecurityTokens.ink,
              ),
            ),
          ],
        ),
      ),
    ],
  );
}
