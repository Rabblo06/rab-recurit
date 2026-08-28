import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/core/auth/biometric_label.dart';

/// The single source of truth for "what does this device's detected
/// biometric type get called/shown as" — every screen (Login/Biometric
/// lock/setup, Profile > Security, the unavailable dialog) calls through
/// `biometricLabel`/`biometricIcon` rather than hardcoding "Face ID"
/// anywhere. This is the full detection matrix: both platforms, both real
/// types, the ambiguous/multiple-types case, and no biometrics at all.
void main() {
  group('biometricLabel', () {
    test('iOS + face -> Face ID', () {
      expect(biometricLabel([RabBiometricType.face], isIOS: true), 'Face ID');
    });

    test('iOS + fingerprint -> Touch ID', () {
      expect(biometricLabel([RabBiometricType.fingerprint], isIOS: true), 'Touch ID');
    });

    test('Android + face -> Face Unlock, never "Face ID"', () {
      expect(biometricLabel([RabBiometricType.face], isIOS: false), 'Face Unlock');
    });

    test('Android + fingerprint -> Fingerprint', () {
      expect(biometricLabel([RabBiometricType.fingerprint], isIOS: false), 'Fingerprint');
    });

    test('no enrolled types -> generic Biometric Login (caller decides whether to show anything at all)', () {
      expect(biometricLabel([], isIOS: true), 'Biometric Login');
      expect(biometricLabel([], isIOS: false), 'Biometric Login');
    });

    test('multiple enrolled types -> generic Biometric Login, not a guess at which one wins', () {
      expect(biometricLabel([RabBiometricType.face, RabBiometricType.fingerprint], isIOS: true), 'Biometric Login');
      expect(biometricLabel([RabBiometricType.face, RabBiometricType.fingerprint], isIOS: false), 'Biometric Login');
    });

    test('an unclassified type (Android strong/weak class) -> generic Biometric Login', () {
      expect(biometricLabel([RabBiometricType.other], isIOS: false), 'Biometric Login');
    });
  });

  group('biometricIcon', () {
    test('face -> the face glyph', () {
      expect(biometricIcon([RabBiometricType.face]), Icons.face_outlined);
    });

    test('fingerprint -> the fingerprint glyph', () {
      expect(biometricIcon([RabBiometricType.fingerprint]), Icons.fingerprint);
    });

    test('unclassified/none/multiple -> the generic fingerprint glyph, never blank', () {
      expect(biometricIcon([RabBiometricType.other]), Icons.fingerprint);
      expect(biometricIcon([]), Icons.fingerprint);
      expect(biometricIcon([RabBiometricType.face, RabBiometricType.fingerprint]), Icons.fingerprint);
    });
  });

  group('primaryBiometricType', () {
    test('exactly one enrolled type is the primary type', () {
      expect(primaryBiometricType([RabBiometricType.face]), RabBiometricType.face);
    });

    test('zero or multiple enrolled types have no single primary type', () {
      expect(primaryBiometricType([]), isNull);
      expect(primaryBiometricType([RabBiometricType.face, RabBiometricType.fingerprint]), isNull);
    });
  });
}
