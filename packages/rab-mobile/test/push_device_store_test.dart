import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/core/push/push_device_store.dart';

import 'support/biometric_test_support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => stubSecureStorageChannel(<String, String>{}));
  tearDown(clearSecureStorageChannel);

  test('generates a device id on first call and persists it across instances', () async {
    final store1 = PushDeviceStore();
    final id1 = await store1.getOrCreateDeviceId();
    expect(id1, isNotEmpty);

    final store2 = PushDeviceStore();
    final id2 = await store2.getOrCreateDeviceId();
    expect(id2, id1); // same underlying secure storage -> same persisted id
  });

  test('calling getOrCreateDeviceId repeatedly on the same store is stable', () async {
    final store = PushDeviceStore();
    final id1 = await store.getOrCreateDeviceId();
    final id2 = await store.getOrCreateDeviceId();
    expect(id1, id2);
  });

  test('two independently-backed stores never collide on an empty store', () async {
    final backing = <String, String>{};
    stubSecureStorageChannel(backing);
    final storeA = PushDeviceStore();
    final idA = await storeA.getOrCreateDeviceId();
    expect(backing.values, contains(idA));
    expect(idA.length, 32); // 16 bytes, hex-encoded
  });
}
