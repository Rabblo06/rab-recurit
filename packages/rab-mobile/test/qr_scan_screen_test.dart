import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:rab_staff/features/home/qr_scan_screen.dart';
import 'package:rab_staff/features/home/clock_presentation.dart';

/// Camera adapter only in tests. No scanner-success seam in production code.
class _Camera extends MobileScannerPlatform {
  final captures = StreamController<BarcodeCapture?>.broadcast();
  bool denied = false;
  int starts = 0, stops = 0;
  @override
  Stream<BarcodeCapture?> get barcodesStream => captures.stream;
  @override
  Stream<TorchState> get torchStateStream => const Stream.empty();
  @override
  Stream<double> get zoomScaleStateStream => const Stream.empty();
  @override
  Widget buildCameraView() => const ColoredBox(
    color: ClockPalette.navy,
    child: Center(
      child: Icon(Icons.storefront_outlined, color: Colors.white70, size: 40),
    ),
  );
  @override
  Future<MobileScannerViewAttributes> start(StartOptions options) async {
    starts++;
    if (denied) {
      throw const MobileScannerException(
        errorCode: MobileScannerErrorCode.permissionDenied,
      );
    }
    return const MobileScannerViewAttributes(
      cameraDirection: CameraFacing.back,
      currentTorchMode: TorchState.off,
      size: Size(640, 480),
    );
  }

  @override
  Future<void> stop() async {
    stops++;
  }

  @override
  Future<void> dispose() async {}
  @override
  Future<void> updateScanWindow(Rect? window) async {}
}

void main() {
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
            ).readAsBytes().then((bytes) => ByteData.sublistView(bytes)),
          ))
          .load();
    }
  });
  late _Camera camera;
  late MobileScannerPlatform previous;
  final boundary = GlobalKey();
  setUp(() {
    previous = MobileScannerPlatform.instance;
    camera = _Camera();
    MobileScannerPlatform.instance = camera;
  });
  tearDown(() async {
    MobileScannerPlatform.instance = previous;
    await camera.captures.close();
  });
  Future<void> mount(
    WidgetTester tester, {
    Size size = const Size(390, 844),
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              child: const Text('Open'),
              onPressed: () async {
                final result = await Navigator.of(context).push<String?>(
                  MaterialPageRoute(
                    builder: (_) => RepaintBoundary(
                      key: boundary,
                      child: const QrScanScreen(),
                    ),
                  ),
                );
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(result == null ? 'Cancelled' : 'Captured'),
                    ),
                  );
                }
              },
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
  }

  Future<void> capture(WidgetTester tester, String name) async {
    expect(tester.takeException(), isNull);
    if (!const bool.fromEnvironment('CLOCK_VISUAL_CAPTURE')) return;
    final render =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    await tester.runAsync(() async {
      final image = await render.toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File(
        '.qa-screenshots/$name.png',
      ).writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  for (final width in [360.0, 390.0, 430.0]) {
    testWidgets('scanner fits $width and cancellation stops camera', (
      tester,
    ) async {
      await mount(tester, size: Size(width, 844));
      expect(find.text('Scan venue QR'), findsOneWidget);
      await capture(tester, 'qr-scanning-${width.toInt()}');
      await tester.tap(find.text('Cancel scan'));
      await tester.pumpAndSettle();
      expect(find.text('Cancelled'), findsOneWidget);
      expect(camera.stops, greaterThan(0));
    });
  }
  testWidgets('camera denied gives retry and cancel, never fake success', (
    tester,
  ) async {
    camera.denied = true;
    await mount(tester);
    expect(find.text('Camera unavailable'), findsOneWidget);
    await capture(tester, 'qr-permission-denied');
    camera.denied = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(camera.starts, 2);
    expect(find.text('Captured'), findsNothing);
    await tester.tap(find.text('Cancel scan'));
    await tester.pumpAndSettle();
  });
  testWidgets('duplicate captures pop exactly once and stop the scanner', (
    tester,
  ) async {
    await mount(tester);
    final capture = BarcodeCapture(
      barcodes: [const Barcode(rawValue: 'test-only-scan')],
    );
    camera.captures.add(capture);
    camera.captures.add(capture);
    await tester.pumpAndSettle();
    expect(find.text('Captured'), findsOneWidget);
    expect(find.text('Open'), findsOneWidget);
    expect(camera.stops, greaterThan(0));
  });
  testWidgets('camera stops on interruption and restarts on resume', (
    tester,
  ) async {
    await mount(tester);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pumpAndSettle();
    expect(camera.stops, greaterThan(0));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(camera.starts, 2);
    await tester.tap(find.text('Cancel scan'));
    await tester.pumpAndSettle();
  });
}
