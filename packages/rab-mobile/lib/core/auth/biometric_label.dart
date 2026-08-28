import 'package:flutter/material.dart';

import 'biometric_authenticator.dart';

/// The one thing every screen asks first: "what did the device actually
/// report?" `null` means either no single enrolled type is reported (Android
/// commonly reports a capability class — `strong`/`weak` — rather than
/// face-vs-fingerprint) or more than one type is enrolled — in both cases
/// there's no single glyph/name to commit to, so `biometricLabel`/
/// `biometricIcon` fall back to a generic "Biometric Login" treatment
/// rather than guessing. The OS's own biometric prompt is still used for
/// the actual authentication either way (`BiometricAuthenticator.
/// authenticate`) — this only decides what the app *calls* it.
RabBiometricType? primaryBiometricType(List<RabBiometricType> enrolledTypes) {
  if (enrolledTypes.length != 1) return null;
  return enrolledTypes.single;
}

/// The one place platform-appropriate biometric wording is decided — no
/// screen ever hardcodes "Face ID"/"Touch ID"/"Fingerprint" itself, all of
/// them call this. Apple naming ("Face ID"/"Touch ID") only ever appears on
/// iOS; Android gets its own real per-type names ("Face Unlock"/
/// "Fingerprint") instead of always falling back to the generic label.
String biometricLabel(List<RabBiometricType> enrolledTypes, {required bool isIOS}) {
  final type = primaryBiometricType(enrolledTypes);
  if (type == null) return 'Biometric Login';
  if (isIOS) {
    if (type == RabBiometricType.face) return 'Face ID';
    if (type == RabBiometricType.fingerprint) return 'Touch ID';
  } else {
    if (type == RabBiometricType.face) return 'Face Unlock';
    if (type == RabBiometricType.fingerprint) return 'Fingerprint';
  }
  return 'Biometric Login';
}

/// Companion to [biometricLabel] — same detected-type input, the matching
/// glyph instead of wording. Platform-independent (the icon reads the same
/// on iOS/Android for a given type; only the label text differs by platform).
IconData biometricIcon(List<RabBiometricType> enrolledTypes) {
  switch (primaryBiometricType(enrolledTypes)) {
    case RabBiometricType.face:
      return Icons.face_outlined;
    case RabBiometricType.fingerprint:
    case RabBiometricType.other:
    case null:
      return Icons.fingerprint;
  }
}
