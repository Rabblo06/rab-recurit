import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:rab_staff/app.dart';
import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/auth/auth_provider.dart';
import 'package:rab_staff/core/theme/tokens.dart';
import 'package:rab_staff/core/widgets/rab_auth_sheet.dart';
import 'package:rab_staff/features/login/login_sheet_content.dart';
import 'support/biometric_test_support.dart';

void main() {
  setUp(() => stubSecureStorageChannel({}));
  tearDown(clearSecureStorageChannel);
  for (final target in ['staff_app', 'venue_manager_app']) {
    testWidgets('legacy $target reset returns to universal login', (
      tester,
    ) async {
      var requests = 0;
      final auth = AuthProvider(
        apiClient: ApiClient(
          httpClient: MockClient((_) async {
            requests++;
            return http.Response('{}', 401);
          }),
        ),
        biometricAuthenticator: FakeBiometricAuthenticator(),
      );
      addTearDown(auth.dispose);
      await tester.pumpWidget(
        ChangeNotifierProvider.value(value: auth, child: const RabApp()),
      );
      await tester.pumpAndSettle();
      tester
          .state<NavigatorState>(find.byType(Navigator).first)
          .pushNamed('rab://login?applicationTarget=$target');
      await tester.pumpAndSettle();
      expect(find.text('Application'), findsNothing);
      expect(auth.phase, AuthPhase.unauthenticated);
      expect(auth.user, isNull);
      expect(find.byKey(const ValueKey('login-application')), findsNothing);
      expect(requests, 0);
      expect(tester.takeException(), isNull);
    });
  }
  setUpAll(() async {
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
  });
  for (final target in ['staff_app', 'venue_manager_app']) {
    for (final status in [401, 403, 429]) {
      testWidgets(
        '$target displays $status and prevents duplicate submission',
        (tester) async {
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = const Size(393, 852);
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          var calls = 0;
          final appName = target == 'staff_app'
              ? 'Staff app'
              : 'Venue Manager app';
          final auth = AuthProvider(
            apiClient: ApiClient(
              httpClient: MockClient((request) async {
                calls++;
                expect(
                  (jsonDecode(request.body) as Map).keys,
                  unorderedEquals(['email', 'password']),
                );
                expect(
                  request.headers.containsKey('X-Application-Target'),
                  isFalse,
                );
                return http.Response(
                  jsonEncode({
                    'message':
                        'This account does not have access to the $appName.',
                  }),
                  status,
                  headers: {'retry-after': '120'},
                );
              }),
            ),
            biometricAuthenticator: FakeBiometricAuthenticator(),
          );
          addTearDown(auth.dispose);
          final boundary = GlobalKey();
          await tester.pumpWidget(
            ChangeNotifierProvider.value(
              value: auth,
              child: MaterialApp(
                theme: buildLightTheme(),
                home: RepaintBoundary(
                  key: boundary,
                  child: const Scaffold(
                    backgroundColor: Colors.black,
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
          if (const bool.fromEnvironment('AUTH_VISUAL_CAPTURE') &&
              status == 401 &&
              target == 'staff_app') {
            await tester.pumpAndSettle();
            await tester.runAsync(() async {
              final image =
                  await (boundary.currentContext!.findRenderObject()
                          as RenderRepaintBoundary)
                      .toImage(pixelRatio: 2);
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await File(
                '.qa-screenshots/auth/universal-login-widget.png',
              ).writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
          }
          await tester.enterText(
            find.byType(TextField).first,
            'qa@example.test',
          );
          await tester.enterText(
            find.byType(TextField).last,
            'VisualOnlyPassword1!',
          );
          await tester.pump();
          final button = find.widgetWithText(FilledButton, 'Log in');
          final submit = tester.widget<FilledButton>(button).onPressed!;
          await tester.runAsync(() async {
            submit();
            submit();
            await Future<void>.delayed(const Duration(milliseconds: 100));
          });
          await tester.pumpAndSettle();
          expect(calls, 1);
          expect(
            find.text(
              status == 401
                  ? 'Invalid email or password.'
                  : status == 403
                  ? 'This account does not have access to the $appName.'
                  : 'Too many requests. Please try again in 2 minutes.',
            ),
            findsOneWidget,
          );
          if (status == 429) {
            expect(tester.widget<FilledButton>(button).onPressed, isNull);
          }
          expect(tester.takeException(), isNull);
          if (const bool.fromEnvironment('AUTH_VISUAL_CAPTURE')) {
            await tester.runAsync(() async {
              final image =
                  await (boundary.currentContext!.findRenderObject()
                          as RenderRepaintBoundary)
                      .toImage(pixelRatio: 2);
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await Directory('.qa-screenshots/auth').create(recursive: true);
              await File(
                '.qa-screenshots/auth/mobile-$target-$status.png',
              ).writeAsBytes(bytes!.buffer.asUint8List());
              image.dispose();
            });
          }
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }
}
