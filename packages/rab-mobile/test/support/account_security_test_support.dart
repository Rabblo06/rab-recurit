import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/auth/biometric_authenticator.dart';
import 'package:rab_staff/core/models/current_user.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/security/security_platform.dart';

import 'biometric_test_support.dart';

/// Records every platform call the security screens make; never touches a
/// real clipboard, share sheet, launcher or window flag.
class FakeSecurityPlatform extends SecurityPlatform {
  final secureCalls = <bool>[];
  final copied = <String>[];
  final shared = <String>[];
  final opened = <Uri>[];
  bool openSucceeds = true;

  bool? get secure => secureCalls.isEmpty ? null : secureCalls.last;

  @override
  Future<void> setSecureWindow(bool secure) async => secureCalls.add(secure);

  @override
  Future<void> copySensitive(String text) async => copied.add(text);

  @override
  Future<bool> openAuthenticator(Uri uri) async {
    opened.add(uri);
    return openSucceeds;
  }

  @override
  Future<bool> openStore(Uri uri) async {
    opened.add(uri);
    return true;
  }

  @override
  Future<void> shareText(String text, {String? subject}) async =>
      shared.add(text);
}

FakeSecurityPlatform installFakeSecurityPlatform() {
  final fake = FakeSecurityPlatform();
  SecurityPlatform.instance = fake;
  SecureWindow.resetForTest();
  addTearDown(() {
    SecurityPlatform.instance = SecurityPlatform();
    SecureWindow.resetForTest();
  });
  return fake;
}

http.Response jsonResponse(Object? body, int status) => http.Response(
  body == null ? '' : jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

Map<String, dynamic> mfaStatusJson({
  bool enabled = false,
  int remaining = 0,
  int total = 0,
  bool enforced = false,
  bool enrolmentAvailable = true,
  bool hasPassword = true,
}) => {
  'enabled': enabled,
  'enabledAt': enabled ? '2026-10-24T09:00:00.000Z' : null,
  'recoveryCodesRemaining': enabled ? remaining : 0,
  'recoveryCodesTotal': enabled ? total : 0,
  'enforced': enforced,
  'enrolmentAvailable': enrolmentAvailable,
  'mobileChallenged': enabled,
  'hasPassword': hasPassword,
  'linkedProviders': hasPassword ? <String>[] : ['microsoft'],
  'ssoReauthProviders': <String>[],
};

/// Test data only: shaped like the server's codes (XXXX-XXXX-XXXX-XXXX).
const testRecoveryCodes = [
  'K7MP-2XQ9-4TZR-8HWE',
  'Q2NC-6VLA-P9DY-3JKU',
  'M5SA-7RGX-W8BE-1FTO',
  'C3HU-9ZNE-V6LQ-5MYD',
  'R1XW-4PAK-J2GT-8CVS',
  'B4KD-7NQE-H3RW-2YTA',
  'F8LZ-1MVC-S6JP-9XGE',
  'T2HN-5WQB-D7KF-4RZM',
  'Y9CE-3GPX-L1VS-6NAD',
  'N6RT-8JDK-E2WM-7QHB',
];

/// Test data only (not a real secret).
const testOtpauthUri =
    'otpauth://totp/Crewflow:stafftest1%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Crewflow&algorithm=SHA1&digits=6&period=30';
const testManualKey = 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP';

CurrentUser testStaffUser() => CurrentUser(
  id: 'user-1',
  email: 'stafftest1@example.test',
  firstName: 'Staff',
  lastName: 'Test 1',
  organisationId: 'org-1',
  roles: const ['staff'],
  mustResetPassword: false,
);

/// An [AuthProvider] over [client], initialised, with a signed-in [user].
Future<AuthProvider> signedInAuth(
  WidgetTester tester,
  MockClient client, {
  BiometricCapability capability = const BiometricCapability(
    hasHardware: true,
    isEnrolled: true,
    enrolledTypes: [RabBiometricType.fingerprint],
  ),
  bool biometricOn = false,
}) async {
  stubSecureStorageChannel({});
  addTearDown(clearSecureStorageChannel);
  final auth = AuthProvider(
    apiClient: ApiClient(httpClient: client),
    biometricAuthenticator: FakeBiometricAuthenticator(capability: capability),
  );
  addTearDown(auth.dispose);
  await tester.runAsync(() => auth.initialized);
  auth.user = testStaffUser();
  auth.biometricEnabledForCurrentUser = biometricOn;
  return auth;
}

/// Hosts [home] the way the app does: providers above the one Navigator, the
/// app's own light and dark themes, [dark] standing in for the phone setting.
Widget securityHarness(AuthProvider auth, Widget home, {bool dark = false}) =>
    ChangeNotifierProvider<AuthProvider>.value(
      value: auth,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildLightTheme(),
        darkTheme: buildDarkTheme(),
        themeMode: dark ? ThemeMode.dark : ThemeMode.light,
        home: home,
      ),
    );

Future<void> settleFrames(WidgetTester tester, [int frames = 40]) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

/// Real glyphs for goldens (the same Roboto/MaterialIcons the other goldens use).
Future<void> loadGoldenFonts() async {
  final fonts =
      '${File(Platform.resolvedExecutable).parent.parent.parent.path}/material_fonts';
  for (final entry in {
    'Roboto': 'roboto-regular.ttf',
    'MaterialIcons': 'materialicons-regular.otf',
  }.entries) {
    await (FontLoader(entry.key)..addFont(
          File(
            '$fonts/${entry.value}',
          ).readAsBytes().then(ByteData.sublistView),
        ))
        .load();
  }
}
