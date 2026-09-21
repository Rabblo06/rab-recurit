import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/features/set_password/set_password_sheet_content.dart';
import 'support/biometric_test_support.dart';

void main() {
  setUp(() => stubSecureStorageChannel({}));
  tearDown(clearSecureStorageChannel);
  for (final success in [true, false]) {
    testWidgets('password setup success=$success stays on page', (
      tester,
    ) async {
      final paths = <String>[];
      final auth = AuthProvider(
        apiClient: ApiClient(
          httpClient: MockClient((request) async {
            paths.add(request.url.path);
            return http.Response(
              success ? '' : '{"message":"Unable to update password."}',
              success ? 204 : 400,
            );
          }),
        ),
        biometricAuthenticator: FakeBiometricAuthenticator(),
      );
      addTearDown(auth.dispose);
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: auth,
          child: MaterialApp(
            theme: buildLightTheme(),
            home: const Scaffold(
              body: SingleChildScrollView(
                child: SetPasswordSheetContent(reveal: 1),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      auth.phase = AuthPhase.mustResetPassword;
      await tester.enterText(
        find.byType(TextField).first,
        'StrongPassword123!',
      );
      await tester.enterText(find.byType(TextField).last, 'StrongPassword123!');
      await tester.pump();
      await tester.runAsync(() async {
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed!();
        await Future<void>.delayed(const Duration(milliseconds: 100));
      });
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 3));
      expect(auth.phase, AuthPhase.mustResetPassword);
      expect(paths, ['/rest/v1/auth/set-password']);
      if (success) {
        expect(find.text('Password updated successfully'), findsOneWidget);
        expect(find.text('Go back to login'), findsOneWidget);
        expect(find.byType(TextField), findsNothing);
        expect(find.byType(FilledButton), findsNothing);
        await tester.tap(find.text('Go back to login'));
        await tester.pumpAndSettle();
        expect(auth.phase, AuthPhase.unauthenticated);
      } else {
        expect(find.text('Unable to update password.'), findsOneWidget);
        expect(find.text('Password updated successfully'), findsNothing);
      }
    });
  }
}
