import 'biometric_authenticator.dart';

/// The one place platform-appropriate biometric wording is decided — no
/// screen re-derives this itself. "Face ID"/"Touch ID" only ever appears on
/// iOS, and only when the enrolled type is unambiguous; every other case
/// (Android essentially always, since `BiometricPrompt` typically reports a
/// capability class rather than face-vs-fingerprint) uses the generic
/// "Biometric Login" wording.
String biometricLabel(List<RabBiometricType> enrolledTypes, {required bool isIOS}) {
  if (isIOS) {
    if (enrolledTypes.length == 1) {
      if (enrolledTypes.single == RabBiometricType.face) return 'Face ID';
      if (enrolledTypes.single == RabBiometricType.fingerprint) return 'Touch ID';
    }
  }
  return 'Biometric Login';
}
