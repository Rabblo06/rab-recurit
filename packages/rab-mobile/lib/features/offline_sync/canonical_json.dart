import 'dart:convert';

/// RFC 8785 (JSON Canonicalization Scheme) for the value types an offline entry uses: maps with string keys, lists,
/// strings, booleans, null, integers and finite doubles. DESIGN §6.2: every entry is signed over the canonical JSON of
/// every field except `sig`, and the server hashes the same bytes for idempotency (§7.3), so the phone and the server
/// must produce byte-identical output.
///
/// - Object members sorted by their keys' UTF-16 code units (Dart's [String.compareTo] compares code units).
/// - No whitespace.
/// - Strings: only `"`, `\`, and U+0000..U+001F are escaped (`\b \f \n \r \t`, else `\u00xx` lower-case hex).
///   Everything else, including non-ASCII and `/`, is written as is.
/// - Numbers: the ECMAScript `Number.prototype.toString` form. Dart's [double.toString] follows the same shortest
///   round-trip algorithm and exponent thresholds; integral values below 1e21 are written without a fraction
///   (`14.0` → `14`), and `-0.0` as `0`. NaN and infinities are refused, as are integers outside ±(2^53 − 1), which
///   ECMAScript cannot represent exactly.
String canonicalJson(Object? value) {
  final out = StringBuffer();
  _write(out, value);
  return out.toString();
}

/// The UTF-8 bytes of [canonicalJson]: what is signed and hashed.
List<int> canonicalJsonBytes(Object? value) =>
    utf8.encode(canonicalJson(value));

const int _maxSafeInteger = 9007199254740991;

void _write(StringBuffer out, Object? value) {
  switch (value) {
    case null:
      out.write('null');
    case bool b:
      out.write(b ? 'true' : 'false');
    case int i:
      if (i > _maxSafeInteger || i < -_maxSafeInteger) {
        throw ArgumentError.value(i, 'value', 'integer outside ±(2^53 − 1)');
      }
      out.write(i.toString());
    case double d:
      out.write(_number(d));
    case String s:
      _string(out, s);
    case List<Object?> list:
      out.write('[');
      for (var i = 0; i < list.length; i++) {
        if (i > 0) out.write(',');
        _write(out, list[i]);
      }
      out.write(']');
    case Map<Object?, Object?> map:
      final keys = map.keys.map((k) {
        if (k is! String) {
          throw ArgumentError.value(k, 'key', 'object keys must be strings');
        }
        return k;
      }).toList()..sort();
      out.write('{');
      for (var i = 0; i < keys.length; i++) {
        if (i > 0) out.write(',');
        _string(out, keys[i]);
        out.write(':');
        _write(out, map[keys[i]]);
      }
      out.write('}');
    default:
      throw ArgumentError.value(value, 'value', 'not a JSON value');
  }
}

String _number(double d) {
  if (d.isNaN || d.isInfinite) {
    throw ArgumentError.value(d, 'value', 'NaN and infinities are not JSON');
  }
  if (d == 0) return '0'; // also -0.0
  if (d == d.truncateToDouble() && d.abs() < 1e21) {
    return BigInt.from(d).toString();
  }
  return d.toString();
}

void _string(StringBuffer out, String s) {
  out.write('"');
  for (final unit in s.codeUnits) {
    switch (unit) {
      case 0x22:
        out.write(r'\"');
      case 0x5C:
        out.write(r'\\');
      case 0x08:
        out.write(r'\b');
      case 0x0C:
        out.write(r'\f');
      case 0x0A:
        out.write(r'\n');
      case 0x0D:
        out.write(r'\r');
      case 0x09:
        out.write(r'\t');
      default:
        if (unit < 0x20) {
          out.write(r'\u');
          out.write(unit.toRadixString(16).padLeft(4, '0'));
        } else {
          out.writeCharCode(unit);
        }
    }
  }
  out.write('"');
}
