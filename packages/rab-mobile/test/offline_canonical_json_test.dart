import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/features/offline_sync/canonical_json.dart';

/// M4 offline queue: entries are signed (DESIGN §6.2) and hashed for idempotency (§7.3) over RFC 8785 canonical JSON,
/// so the phone must produce exactly the bytes the server produces.
void main() {
  test(
    'RFC 8785 §3.2.2 sample: sorted keys, ECMAScript numbers, minimal escapes',
    () {
      // The same values as the RFC's JSON text, built directly (no parser in between).
      final input = {
        'numbers': [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27],
        'string': '€\$\u000f\nA\'B"\\\\"/',
        'literals': [null, true, false],
      };
      expect(
        canonicalJson(input),
        r'{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
        r'"string":"€$\u000f\nA'
        "'"
        r'B\"\\\\\"/"}',
      );
    },
  );

  test('keys sort by UTF-16 code units, nested objects too', () {
    expect(
      canonicalJson({
        'b': 1,
        'a': {'z': true, 'A': false},
        '€': 'euro',
        '\r': 'cr',
        '1': 'one',
      }),
      '{"\\r":"cr","1":"one","a":{"A":false,"z":true},"b":1,"€":"euro"}',
    );
    // A supplementary character (surrogate pair) sorts by its high surrogate, before U+FB33.
    expect(canonicalJson({'דּ': 1, '😀': 2}), '{"😀":2,"דּ":1}');
  });

  test(
    'integral doubles drop the fraction; -0.0 is 0; coordinates keep their digits',
    () {
      expect(
        canonicalJson([14.0, -0.0, 51.5, -0.12, 1e21, 1e-7, 100]),
        '[14,0,51.5,-0.12,1e+21,1e-7,100]',
      );
    },
  );

  test(
    'control characters escape as lower-case \\u00xx; nothing else is escaped',
    () {
      expect(canonicalJson('\u0001\u001f/<> é'), '"\\u0001\\u001f/<> é"');
    },
  );

  test('refuses values that have no exact JSON form', () {
    expect(() => canonicalJson(double.nan), throwsArgumentError);
    expect(() => canonicalJson(double.infinity), throwsArgumentError);
    expect(() => canonicalJson(9007199254740992), throwsArgumentError);
    expect(() => canonicalJson({1: 'x'}), throwsArgumentError);
    expect(() => canonicalJson(DateTime(2026)), throwsArgumentError);
  });

  test('output parses back to the same value', () {
    final value = {
      'idempotencyKey': '0d6c3c2e-0000-4000-8000-000000000000',
      'location': {'lat': 51.5, 'lng': -0.12, 'accuracyM': 14.0, 'mock': false},
      'clientSeq': 41,
    };
    expect(jsonDecode(canonicalJson(value)), value);
    expect(canonicalJsonBytes(value), utf8.encode(canonicalJson(value)));
  });
}
