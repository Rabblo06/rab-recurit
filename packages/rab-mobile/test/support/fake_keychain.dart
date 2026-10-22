import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/core/storage/secure_storage_bootstrap.dart';

/// One stored generic-password item: its value and the `kSecAttrAccessible`
/// it was written with.
class FakeKeychainItem {
  FakeKeychainItem(this.value, this.accessibility, this.synchronizable);
  String value;
  final String accessibility;
  final String synchronizable;
}

/// A `flutter_secure_storage` channel stub with the iOS plugin's Keychain
/// semantics (flutter_secure_storage_darwin 0.4.0, FlutterSecureStorage.swift):
/// - read/readAll/containsKey put `kSecAttrAccessible` in the query, so they
///   only see items written with the SAME accessibility;
/// - an item's identity is (service, account): adding an account that
///   already exists under another accessibility fails with
///   errSecDuplicateItem (-25299);
/// - delete/deleteAll drop the accessibility from the query and so remove
///   every variant.
/// Every call and its options are recorded in [calls].
class FakeKeychain {
  FakeKeychain() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, _handle);
  }

  static const channel = MethodChannel(
    'plugins.it_nomads.com/flutter_secure_storage',
  );

  final items = <String, FakeKeychainItem>{};
  final calls = <MethodCall>[];

  /// When set, every call throws this (e.g. errSecInteractionNotAllowed).
  PlatformException? failWith;

  static void detach() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .setMockMethodCallHandler(channel, null);

  /// Seeds an item as a given build would have written it.
  void seed(
    String key,
    String value, {
    String accessibility = 'first_unlock_this_device',
  }) => items[key] = FakeKeychainItem(value, accessibility, 'false');

  Map<String, String> valuesWith(String accessibility) => {
    for (final e in items.entries)
      if (e.value.accessibility == accessibility) e.key: e.value.value,
  };

  Iterable<Map> optionsOf(String method) => calls
      .where((c) => c.method == method)
      .map((c) => (c.arguments as Map)['options'] as Map);

  Future<Object?> _handle(MethodCall call) async {
    calls.add(call);
    if (failWith != null) throw failWith!;
    final args = call.arguments as Map;
    final options = (args['options'] as Map).cast<String, String>();
    final accessibility = options['accessibility'] ?? 'unlocked';
    final key = args['key'] as String?;
    bool visible(FakeKeychainItem? item) =>
        item != null && item.accessibility == accessibility;
    switch (call.method) {
      case 'read':
        final item = items[key];
        return visible(item) ? item!.value : null;
      case 'containsKey':
        return visible(items[key]);
      case 'readAll':
        return valuesWith(accessibility);
      case 'write':
        final existing = items[key];
        if (existing == null) {
          items[key!] = FakeKeychainItem(
            args['value'] as String,
            accessibility,
            options['synchronizable'] ?? 'false',
          );
        } else if (visible(existing)) {
          existing.value = args['value'] as String;
        } else {
          throw PlatformException(code: '-25299', message: 'errSecDuplicateItem');
        }
        return null;
      case 'delete':
        items.remove(key);
        return null;
      case 'deleteAll':
        items.clear();
        return null;
      default:
        return null;
    }
  }
}

/// In-memory [InstallMarker].
class FakeInstallMarker implements InstallMarker {
  FakeInstallMarker({this.present = false});
  bool present;
  Object? existsError;
  int creates = 0;

  @override
  Future<bool> exists() async {
    if (existsError != null) throw existsError!;
    return present;
  }

  @override
  Future<void> create() async {
    creates++;
    present = true;
  }
}
