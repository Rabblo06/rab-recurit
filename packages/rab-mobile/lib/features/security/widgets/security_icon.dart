import 'package:flutter/material.dart';

/// The design's own 24×24 stroke icons (`paths` in
/// `crewflow-account-security.html`: stroke-width 1.65, round caps and joins),
/// painted natively so the security screens match the design instead of
/// approximating it with Material glyphs. Decorative: always excluded from
/// semantics (the design marks every icon `aria-hidden`); the control that
/// holds one carries the label.
enum SecurityGlyph {
  shield(
    'M12 3L20 6V12C20 17 16 20 12 22C8 20 4 17 4 12V6L12 3Z M8 12L11 15L16 10',
  ),
  lock('M6 10H18V21H6Z M8 10V7A4 4 0 0 1 16 7V10 M12 14V17'),
  back('M15 5L8 12L15 19'),
  chevron('M9 5L16 12L9 19'),
  check('M5 12L10 17L20 7'),
  info('M12 8H12.01 M12 11V16 M22 12A10 10 0 1 1 2 12A10 10 0 1 1 22 12'),
  phone('M7 2H17V22H7Z M10 18H14'),
  copy('M8 8H21V21H8Z M16 8V3H3V16H8'),
  download('M12 3V15 M7 10L12 15L17 10 M4 17V21H20V17'),
  eye(
    'M2 12C6 4 18 4 22 12C18 20 6 20 2 12Z M15 12A3 3 0 1 1 9 12A3 3 0 1 1 15 12',
  ),
  eyeOff(
    'M2 12C6 4 18 4 22 12C18 20 6 20 2 12Z M15 12A3 3 0 1 1 9 12A3 3 0 1 1 15 12 M4 4L20 20',
  ),
  refresh('M20 6V11H15 M4 18V13H9 M20 11A8 8 0 0 0 6 6 M4 13A8 8 0 0 0 18 18'),
  key('M14 10A5 5 0 1 0 4 10A5 5 0 1 0 14 10 M14 10H22 M19 10V14'),
  arrow('M5 12H19 M13 6L19 12L13 18');

  const SecurityGlyph(this.data);
  final String data;
}

class SecurityIcon extends StatelessWidget {
  const SecurityIcon(
    this.glyph, {
    super.key,
    this.size = 20,
    this.color,
    this.strokeWidth = 1.65,
  });

  final SecurityGlyph glyph;
  final double size;
  final Color? color;
  final double strokeWidth;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: SizedBox.square(
      dimension: size,
      child: CustomPaint(
        painter: _GlyphPainter(
          _parse(glyph.data),
          color ?? IconTheme.of(context).color ?? Colors.black,
          strokeWidth,
        ),
      ),
    ),
  );
}

final Map<String, Path> _cache = {};

/// Parses the absolute-coordinate subset the design uses: M L H V C A Z.
Path _parse(String data) => _cache.putIfAbsent(data, () {
  final tokens = RegExp(
    r'[MLHVCAZ]|-?\d*\.?\d+',
  ).allMatches(data).map((m) => m.group(0)!).toList();
  final path = Path();
  var i = 0;
  var command = 'M';
  var current = Offset.zero;
  var start = Offset.zero;
  double next() => double.parse(tokens[i++]);
  while (i < tokens.length) {
    final token = tokens[i];
    if (RegExp(r'^[MLHVCAZ]$').hasMatch(token)) {
      command = token;
      i++;
      if (command == 'Z') {
        path.close();
        current = start;
      }
      continue;
    }
    switch (command) {
      case 'M':
        current = Offset(next(), next());
        start = current;
        path.moveTo(current.dx, current.dy);
        command = 'L';
      case 'L':
        current = Offset(next(), next());
        path.lineTo(current.dx, current.dy);
      case 'H':
        current = Offset(next(), current.dy);
        path.lineTo(current.dx, current.dy);
      case 'V':
        current = Offset(current.dx, next());
        path.lineTo(current.dx, current.dy);
      case 'C':
        final c1 = Offset(next(), next());
        final c2 = Offset(next(), next());
        current = Offset(next(), next());
        path.cubicTo(c1.dx, c1.dy, c2.dx, c2.dy, current.dx, current.dy);
      case 'A':
        final rx = next();
        final ry = next();
        final rotation = next();
        final large = next() != 0;
        final sweep = next() != 0;
        current = Offset(next(), next());
        path.arcToPoint(
          current,
          radius: Radius.elliptical(rx, ry),
          rotation: rotation,
          largeArc: large,
          clockwise: sweep,
        );
      default:
        i++;
    }
  }
  return path;
});

class _GlyphPainter extends CustomPainter {
  _GlyphPainter(this.path, this.color, this.strokeWidth);
  final Path path;
  final Color color;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.width / 24;
    canvas.scale(scale);
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..color = color,
    );
  }

  @override
  bool shouldRepaint(_GlyphPainter old) =>
      old.path != path || old.color != color || old.strokeWidth != strokeWidth;
}
