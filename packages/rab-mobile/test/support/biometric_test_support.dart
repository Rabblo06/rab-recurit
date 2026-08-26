import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';

/// Waits until `auth.phase` is no longer [from] — used to wait past the
/// initial `AuthPhase.loading` state without polling.
Future<void> waitUntilPhaseNot(AuthProvider auth, AuthPhase from) async {
  if (auth.phase != from) return;
  final completer = Completer<void>();
  void listener() {
    if (auth.phase != from) completer.complete();
  }

  auth.addListener(listener);
  await completer.future;
  auth.removeListener(listener);
}

/// Plain-Dart fake — no platform channel involved, immune to `local_auth`'s
/// own internal implementation. `capability`/`outcome` are mutable so a
/// single test can change device state mid-flow (e.g. simulate biometrics
/// becoming unavailable between app opens).
class FakeBiometricAuthenticator implements BiometricAuthenticator {
  FakeBiometricAuthenticator({
    this.capability = const BiometricCapability(
      hasHardware: true,
      isEnrolled: true,
      enrolledTypes: [RabBiometricType.fingerprint],
    ),
    this.outcome = BiometricOutcome.success,
  });

  BiometricCapability capability;
  BiometricOutcome outcome;
  int authenticateCalls = 0;

  @override
  Future<BiometricCapability> getCapability() async => capability;

  @override
  Future<BiometricOutcome> authenticate({required String reason}) async {
    authenticateCalls++;
    return outcome;
  }
}

/// Same `flutter_secure_storage` channel stub used by Increment 1's tests —
/// `BiometricStore` rides the same primitive `ApiClient` already uses, so
/// no separate storage mock is needed.
MethodChannel stubSecureStorageChannel(Map<String, String> store) {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
    final args = call.arguments is Map ? call.arguments as Map : const {};
    switch (call.method) {
      case 'write':
        store[args['key'] as String] = args['value'] as String;
        return null;
      case 'read':
        return store[args['key'] as String];
      case 'delete':
        store.remove(args['key'] as String);
        return null;
      case 'containsKey':
        return store.containsKey(args['key'] as String);
      default:
        return null;
    }
  });
  return channel;
}

void clearSecureStorageChannel() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
}

Map<String, dynamic> fakeUserJson({
  String id = 'user-1',
  String email = 'alice@example.test',
  bool mustResetPassword = false,
}) =>
    {
      'id': id,
      'email': email,
      'firstName': 'Alice',
      'lastName': 'Example',
      'organisationId': 'org-1',
      'roles': ['staff'],
      'mustResetPassword': mustResetPassword,
    };
