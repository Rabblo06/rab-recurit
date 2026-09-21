import 'package:provider/provider.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'support/biometric_test_support.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/rab_auth_sheet.dart';
import 'package:rab_staff/features/login/login_sheet_content.dart';

void main() {
  setUp(() => stubSecureStorageChannel({}));
  tearDown(clearSecureStorageChannel);
  for (final viewport in <(Size, double, double)>[
    (const Size(320, 568), 24, 16),
    (const Size(393, 851), 49.45, 24),
    (const Size(430, 932), 24, 24),
    (const Size(375, 812), 44, 34),
    (const Size(393, 852), 59, 34),
  ]) {
    testWidgets('login remains usable at ${viewport.$1}', (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = viewport.$1;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final auth = AuthProvider(
        apiClient: ApiClient(
          httpClient: MockClient((_) async => http.Response('{}', 401)),
        ),
        biometricAuthenticator: FakeBiometricAuthenticator(),
      );
      addTearDown(auth.dispose);
      Future<void> render({double keyboard = 0}) async {
        final padding = EdgeInsets.only(top: viewport.$2, bottom: viewport.$3);
        await tester.pumpWidget(
          ChangeNotifierProvider.value(
            value: auth,
            child: MaterialApp(
              theme: buildLightTheme(),
              home: MediaQuery(
                data: MediaQueryData(
                  size: viewport.$1,
                  padding: padding,
                  viewPadding: padding,
                  viewInsets: EdgeInsets.only(bottom: keyboard),
                ),
                child: const Scaffold(
                  resizeToAvoidBottomInset: false,
                  body: Stack(
                    children: [
                      AuthSheet(
                        progress: 1,
                        isLogin: true,
                        child: LoginSheetContent(reveal: 1),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await render();
      expect(tester.takeException(), isNull);
      final button = find.widgetWithText(FilledButton, 'Log in');
      expect(tester.widget<FilledButton>(button).onPressed, isNull);
      expect(
        tester.getBottomRight(button).dy,
        lessThanOrEqualTo(viewport.$1.height - viewport.$3 - 16),
      );
      await tester.enterText(
        find.byType(TextField).first,
        'visual.qa@example.com',
      );
      await tester.enterText(find.byType(TextField).last, 'PreviewOnly123!');
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(button).onPressed, isNotNull);
      await tester.tap(find.byTooltip('Show'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField).last).obscureText,
        isFalse,
      );
      await render(keyboard: 260);
      await tester.ensureVisible(button);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(
        tester.getBottomRight(button).dy,
        lessThanOrEqualTo(viewport.$1.height - 260),
      );
    });
  }
}
