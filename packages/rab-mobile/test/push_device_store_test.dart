import 'dart:math';

import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/core/push/push_device_store.dart';

import 'support/biometric_test_support.dart';

final _uuidV4 = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => stubSecureStorageChannel(<String, String>{}));
  tearDown(clearSecureStorageChannel);

  test(
    'generates a UUID v4 on first call and persists it across instances',
    () async {
      final id1 = await PushDeviceStore().getOrCreateDeviceId();
      expect(id1, matches(_uuidV4));
      final id2 = await PushDeviceStore().getOrCreateDeviceId();
      expect(id2, id1); // same underlying secure storage -> same persisted id
    },
  );

  test(
    'calling getOrCreateDeviceId repeatedly on the same store is stable',
    () async {
      final store = PushDeviceStore();
      expect(
        await store.getOrCreateDeviceId(),
        await store.getOrCreateDeviceId(),
      );
    },
  );

  test('an old 32-hex id (never registered by any Flutter build) is replaced '
      'by a UUID — the server only deactivates UUID device ids', () async {
    final backing = <String, String>{
      'rab.push.deviceId': '0123456789abcdef0123456789abcdef',
    };
    stubSecureStorageChannel(backing);
    final id = await PushDeviceStore().getOrCreateDeviceId();
    expect(id, matches(_uuidV4));
    expect(backing['rab.push.deviceId'], id);
    expect(await PushDeviceStore().getOrCreateDeviceId(), id);
  });

  test('two independently-backed stores never collide', () async {
    stubSecureStorageChannel(<String, String>{});
    final idA = await PushDeviceStore().getOrCreateDeviceId();
    clearSecureStorageChannel();
    stubSecureStorageChannel(<String, String>{});
    final idB = await PushDeviceStore().getOrCreateDeviceId();
    expect(idA, matches(_uuidV4));
    expect(idB, matches(_uuidV4));
    expect(idA, isNot(idB));
  });

  test('UUID v4 shape: version and variant bits, every byte random', () {
    for (var seed = 0; seed < 100; seed++) {
      expect(PushDeviceStore.generateUuidV4(Random(seed)), matches(_uuidV4));
    }
    expect(PushDeviceStore.isUuid('0123456789abcdef0123456789abcdef'), isFalse);
  });
}
