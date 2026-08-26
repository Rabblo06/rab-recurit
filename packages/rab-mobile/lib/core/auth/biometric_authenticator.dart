import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:local_auth/local_auth.dart';

/// Our own type, decoupled from `package:local_auth`'s `BiometricType` — the
/// rest of the app (labels, icons) never imports `local_auth` directly, only
/// this file does. Kept deliberately coarse: Android's `BiometricPrompt`
/// generally reports capability class (`strong`/`weak`), not face-vs-
/// fingerprint, so `other` is the common Android case.
enum RabBiometricType { face, fingerprint, other }

class BiometricCapability {
  const BiometricCapability({required this.hasHardware, required this.isEnrolled, required this.enrolledTypes});

  final bool hasHardware;
  final bool isEnrolled;
  final List<RabBiometricType> enrolledTypes;

  /// Both hardware presence AND enrollment are required — hardware alone
  /// (e.g. a sensor with nothing registered) must never surface biometric
  /// UI, per the spec's explicit requirement.
  bool get isAvailable => hasHardware && isEnrolled;

  static const unavailable = BiometricCapability(hasHardware: false, isEnrolled: false, enrolledTypes: []);
}

enum BiometricOutcome { success, cancelled, failed, lockedOut, notAvailable, error }

abstract class BiometricAuthenticator {
  Future<BiometricCapability> getCapability();
  Future<BiometricOutcome> authenticate({required String reason});
}

/// The only file in this app that imports `package:local_auth`. Every
/// failure mode — including the platform channel simply not being
/// registered (e.g. running under `flutter test` with no plugin binding) —
/// is caught and degrades to "not available" rather than throwing, so a
/// probe failure can never crash the app or a test; it just means no
/// biometric UI is offered, which is the safe default anyway.
class LocalAuthBiometricAuthenticator implements BiometricAuthenticator {
  LocalAuthBiometricAuthenticator({LocalAuthentication? localAuth}) : _localAuth = localAuth ?? LocalAuthentication();

  final LocalAuthentication _localAuth;

  @override
  Future<BiometricCapability> getCapability() async {
    try {
      final hasHardware = await _localAuth.canCheckBiometrics;
      if (!hasHardware) return BiometricCapability.unavailable;
      final types = await _localAuth.getAvailableBiometrics();
      return BiometricCapability(
        hasHardware: true,
        isEnrolled: types.isNotEmpty,
        enrolledTypes: types.map(_mapType).toList(),
      );
    } catch (e) {
      debugPrint('BiometricAuthenticator.getCapability failed, treating as unavailable: $e');
      return BiometricCapability.unavailable;
    }
  }

  @override
  Future<BiometricOutcome> authenticate({required String reason}) async {
    try {
      final success = await _localAuth.authenticate(localizedReason: reason, biometricOnly: true);
      return success ? BiometricOutcome.success : BiometricOutcome.failed;
    } on LocalAuthException catch (e) {
      switch (e.code) {
        case LocalAuthExceptionCode.userCanceled:
        case LocalAuthExceptionCode.userRequestedFallback:
        case LocalAuthExceptionCode.systemCanceled:
          return BiometricOutcome.cancelled;
        case LocalAuthExceptionCode.temporaryLockout:
        case LocalAuthExceptionCode.biometricLockout:
          return BiometricOutcome.lockedOut;
        case LocalAuthExceptionCode.noBiometricHardware:
        case LocalAuthExceptionCode.noBiometricsEnrolled:
        case LocalAuthExceptionCode.noCredentialsSet:
        case LocalAuthExceptionCode.biometricHardwareTemporarilyUnavailable:
          return BiometricOutcome.notAvailable;
        default:
          return BiometricOutcome.error;
      }
    } catch (e) {
      debugPrint('BiometricAuthenticator.authenticate failed: $e');
      return BiometricOutcome.error;
    }
  }

  RabBiometricType _mapType(BiometricType type) {
    switch (type) {
      case BiometricType.face:
        return RabBiometricType.face;
      case BiometricType.fingerprint:
        return RabBiometricType.fingerprint;
      default:
        return RabBiometricType.other;
    }
  }
}

bool get isIOSPlatform {
  try {
    return Platform.isIOS;
  } catch (_) {
    return false;
  }
}
