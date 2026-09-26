import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Widget tests have no native location plugin. A quiet stream acknowledges
/// subscription/cancellation without inventing positions or geofence events.
void stubLocationStream() {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
        const MethodChannel('flutter.baseflow.com/geolocator_updates'),
        (_) async => null,
      );
}

void clearLocationStream() {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
        const MethodChannel('flutter.baseflow.com/geolocator_updates'),
        null,
      );
}
