import 'dart:convert';

import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/features/offline_sync/boot_clock.dart';
import 'package:rab_staff/features/offline_sync/canonical_json.dart';
import 'package:rab_staff/features/offline_sync/entry_signer.dart';
import 'package:rab_staff/features/offline_sync/integrity_signal.dart';
import 'package:rab_staff/features/offline_sync/offline_config.dart';
import 'package:rab_staff/features/offline_sync/offline_entry.dart';
import 'package:rab_staff/features/offline_sync/offline_queue_store.dart';
import 'package:rab_staff/features/offline_sync/offline_ticket.dart';

import 'support/biometric_test_support.dart';
import 'support/offline_test_support.dart';

/// M4 offline queue, PR 1: the encrypted-at-rest store (DESIGN §3.2–§3.4). Offline mode itself stays OFF (owner HARD
/// RULE); these tests exercise the storage layer only.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secure;
  late OfflineQueueStore store;
  setUp(() {
    secure = {};
    stubSecureStorageChannel(secure);
    store = OfflineQueueStore();
  });
  tearDown(clearSecureStorageChannel);

  test(
    'HARD RULE: off by default (no build flag, no device key on a real phone)',
    () async {
      expect(kOfflineAttendanceBuildFlag, isFalse);
      const signer = UnavailableEntrySigner();
      expect(signer.isAvailable, isFalse);
      expect(signer.deviceKeyId, isNull);
      expect(await signer.sign([1, 2, 3]), isNull);
    },
  );

  group('integrity signal (§6.4, flag only)', () {
    test(
      'Android with a su binary: true; without: false; other platforms: false',
      () {
        expect(
          rootedSignal(
            isAndroid: true,
            fileExists: (p) => p == '/system/xbin/su',
          ),
          isTrue,
        );
        expect(
          rootedSignal(isAndroid: true, fileExists: (_) => false),
          isFalse,
        );
        expect(
          rootedSignal(isAndroid: false, fileExists: (_) => true),
          isFalse,
        );
        expect(
          rootedSignal(
            isAndroid: true,
            fileExists: (_) => throw const FileSystemException(),
          ),
          isFalse,
        );
      },
    );

    test(
      'an entry without integrity.rootedSignal is refused when read back',
      () {
        final wire = sampleEntry().toWireJson()..remove('integrity');
        expect(() => OfflineEntry.fromWireJson(wire), throwsFormatException);
        expect(sampleEntry().toWireJson()['integrity'], {
          'rootedSignal': false,
        });
      },
    );
  });

  group('entry shape (§3.2)', () {
    test(
      'never carries a server-derived field (organisationId, status, times, money)',
      () {
        final entry = sampleEntry(
          location: const OfflineLocation(
            lat: 51.5,
            lng: -0.12,
            accuracyM: 14,
            fixBootMs: 1099000,
            mock: false,
          ),
        );
        final wire = entry.toWireJson();
        expect(wire.keys.toSet().intersection(kForbiddenEntryFields), isEmpty);
        expect(wire.keys.toSet(), {
          'v',
          'idempotencyKey',
          'clientSeq',
          'type',
          'shiftId',
          'ticket',
          'bootId',
          'ticketBootMs',
          'punchBootId',
          'punchBootMs',
          'deviceWallClockAt',
          'qrToken',
          'location',
          'integrity',
          'appVersion',
          'deviceKeyId',
          'sig',
        });
        expect(wire['type'], 'clock_in');
      },
    );

    test(
      'the signed payload is the canonical JSON of every field except sig',
      () {
        final entry = sampleEntry(sig: 'abc');
        final payload = utf8.decode(entry.signingPayload());
        expect(payload, canonicalJson(entry.signedFields()));
        expect(payload.contains('"sig"'), isFalse);
        expect(jsonDecode(payload)['deviceKeyId'], 'dk-1');
        // Any change to a signed field changes the bytes (so the server's signature check fails).
        final moved = sampleEntry(punchBootMs: 1100001, sig: 'abc');
        expect(moved.signingPayload(), isNot(entry.signingPayload()));
      },
    );

    test('absent optionals are omitted, not null', () {
      final wire = sampleEntry(qrToken: null, sig: null).toWireJson();
      expect(wire.containsKey('qrToken'), isFalse);
      expect(wire.containsKey('location'), isFalse);
      expect(wire.containsKey('sig'), isFalse);
      expect(wire.values.contains(null), isFalse);
    });

    test(
      'round-trips through its wire JSON; a wrong version or type is refused',
      () {
        final entry = sampleEntry(
          type: OfflinePunchType.breakEnd,
          location: const OfflineLocation(
            lat: 1,
            lng: 2,
            accuracyM: 3.5,
            fixBootMs: 4,
            mock: true,
          ),
        );
        final back = OfflineEntry.fromWireJson(
          jsonDecode(jsonEncode(entry.toWireJson())) as Map<String, Object?>,
        );
        expect(back.toWireJson(), entry.toWireJson());
        expect(
          () => OfflineEntry.fromWireJson({...entry.toWireJson(), 'v': 2}),
          throwsFormatException,
        );
        expect(
          () => OfflineEntry.fromWireJson({
            ...entry.toWireJson(),
            'type': 'geofence_exit',
          }),
          throwsFormatException,
        );
      },
    );

    test(
      'age: boot clock while the boot is unchanged, wall clock after a reboot, never negative',
      () {
        final entry = sampleEntry(punchBootMs: 1000);
        final sameBoot = const BootReading(bootId: 'boot-7', elapsedMs: 61000);
        expect(
          entry.ageAt(sameBoot, DateTime.utc(2000)),
          const Duration(minutes: 1),
        );
        final rebooted = const BootReading(bootId: 'boot-8', elapsedMs: 10);
        expect(
          entry.ageAt(rebooted, DateTime.parse('2026-11-24T09:02:12+00:00')),
          const Duration(hours: 72, seconds: 1),
        );
        expect(entry.ageAt(rebooted, DateTime.utc(2020)), Duration.zero);
      },
    );

    test('device wall clock is written with its offset (diagnostics only)', () {
      expect(
        deviceWallClockIso(DateTime.utc(2026, 11, 21, 9, 2, 11)),
        '2026-11-21T09:02:11+00:00',
      );
    });
  });

  group('store (§3.3, §3.4)', () {
    test('keyed per user: one user never sees another user\'s queue', () async {
      await store.append('user-a', samplePunch());
      expect((await store.load('user-a')).entries, hasLength(1));
      expect((await store.load('user-b')).entries, isEmpty);
      expect(secure.keys, contains('rab.offline.queue.user-a'));
      expect(secure.keys.where((k) => k.contains('user-b')), isEmpty);
    });

    test('replay order is clientSeq, whatever the insertion order', () async {
      await store.append('u', samplePunch(key: keyFor(3), seq: 3));
      await store.append('u', samplePunch(key: keyFor(1), seq: 1));
      await store.append('u', samplePunch(key: keyFor(2), seq: 2));
      final seqs = (await store.load(
        'u',
      )).entries.map((e) => e.entry.clientSeq);
      expect(seqs, [1, 2, 3]);
    });

    test('refuses a 31st entry and writes nothing', () async {
      for (var i = 1; i <= OfflineLimits.maxEntries; i++) {
        await store.append('u', samplePunch(key: keyFor(i), seq: i));
      }
      final before = secure['rab.offline.queue.u'];
      await expectLater(
        store.append('u', samplePunch(key: keyFor(99), seq: 99)),
        throwsA(isA<OfflineQueueFullException>()),
      );
      expect(secure['rab.offline.queue.u'], before);
    });

    test('refuses a queue larger than 48 KB', () async {
      final huge = 'x' * (OfflineLimits.maxBytes);
      await expectLater(
        store.append('u', samplePunch(qrToken: huge)),
        throwsA(isA<OfflineQueueFullException>()),
      );
      expect(secure.containsKey('rab.offline.queue.u'), isFalse);
    });

    test('refuses a duplicate idempotency key or sequence number', () async {
      await store.append('u', samplePunch(key: keyFor(1), seq: 1));
      await expectLater(
        store.append('u', samplePunch(key: keyFor(1), seq: 2)),
        throwsStateError,
      );
      await expectLater(
        store.append('u', samplePunch(key: keyFor(2), seq: 1)),
        throwsStateError,
      );
    });

    test(
      'an unreadable queue is reported, never overwritten by a new capture',
      () async {
        secure['rab.offline.queue.u'] = '{not json';
        final snapshot = await store.load('u');
        expect(snapshot.unreadable, isTrue);
        expect(snapshot.entries, isEmpty);
        await expectLater(
          store.append('u', samplePunch()),
          throwsA(isA<OfflineQueueFullException>()),
        );
        expect(secure['rab.offline.queue.u'], '{not json');
        await store.clear('u');
        expect(secure.containsKey('rab.offline.queue.u'), isFalse);
      },
    );

    test(
      'update changes states and deletes acknowledged entries; it can never add one',
      () async {
        await store.append('u', samplePunch(key: keyFor(1), seq: 1));
        await store.append('u', samplePunch(key: keyFor(2), seq: 2));
        final next = await store.update(
          'u',
          (all) => [
            all.last.withState(
              QueuedPunchState.rejected,
              code: 'SHIFT_NOT_OPEN',
            ),
          ],
        );
        expect(next.single.code, 'SHIFT_NOT_OPEN');
        final stored = (await store.load('u')).entries.single;
        expect(stored.state, QueuedPunchState.rejected);
        expect(stored.idempotencyKey, keyFor(2));
        await expectLater(
          store.update(
            'u',
            (all) => [...all, samplePunch(key: keyFor(9), seq: 9)],
          ),
          throwsStateError,
        );
        // Emptying the queue deletes the stored value (nothing left at rest).
        await store.update('u', (_) => []);
        expect(secure.containsKey('rab.offline.queue.u'), isFalse);
      },
    );

    test(
      'security review L4: sync results on a near-full queue never jam it; codes and reasons are capped',
      () async {
        // Fill the queue to just under 48 KB.
        var i = 0;
        while (true) {
          i++;
          try {
            await store.append(
              'u',
              samplePunch(key: keyFor(i), seq: i, qrToken: 'q' * 3000),
            );
          } on OfflineQueueFullException {
            break;
          }
        }
        final before = (await store.load('u')).entries;
        expect(before.length, greaterThan(5));
        final next = await store.update(
          'u',
          (all) => [
            for (final e in all)
              e.withState(
                QueuedPunchState.rejected,
                code: 'A' * 500,
                qrReason: 'r' * 500,
              ),
          ],
        );
        expect(next, hasLength(before.length));
        expect(next.first.code!.length, QueuedPunch.maxCodeLength);
        expect(next.first.qrReason!.length, QueuedPunch.maxReasonLength);
        expect(
          (await store.load(
            'u',
          )).entries.every((e) => e.state == QueuedPunchState.rejected),
          isTrue,
        );
        // A new capture is still refused by the limits.
        await expectLater(
          store.append('u', samplePunch(key: keyFor(999), seq: 999)),
          throwsA(isA<OfflineQueueFullException>()),
        );
      },
    );

    test(
      'clientSeq is strictly increasing, persisted before use, never reused',
      () async {
        final a = await store.nextClientSeq();
        final b = await store.nextClientSeq();
        expect(b, a + 1);
        // A new store instance over the same storage continues the sequence.
        final c = await OfflineQueueStore().nextClientSeq();
        expect(c, b + 1);
        final installId = await store.installId();
        expect(secure['rab.offline.seq.$installId'], '$c');
      },
    );

    test(
      'a corrupt sequence counter fails closed instead of restarting',
      () async {
        final installId = await store.installId();
        secure['rab.offline.seq.$installId'] = 'garbage';
        await expectLater(store.nextClientSeq(), throwsFormatException);
      },
    );

    test('concurrent appends never lose an entry', () async {
      await Future.wait([
        for (var i = 1; i <= 10; i++)
          store.append('u', samplePunch(key: keyFor(i), seq: i)),
      ]);
      expect((await store.load('u')).entries, hasLength(10));
    });

    test('ticket is stored per user and cleared with the queue', () async {
      const ticket = StoredOfflineTicket(
        token: 't',
        bootId: 'boot-7',
        ticketBootMs: 10,
        deviceWallClockAt: '2026-11-21T08:00:00+00:00',
      );
      await store.saveTicket('u', ticket);
      expect((await store.loadTicket('u'))?.token, 't');
      expect(await store.loadTicket('other'), isNull);
      await store.append('u', samplePunch());
      await store.clear('u');
      expect(await store.loadTicket('u'), isNull);
      expect((await store.load('u')).entries, isEmpty);
    });
  });

  group('ticket capture window (§3.4, §4.3)', () {
    const ticket = StoredOfflineTicket(
      token: 't',
      bootId: 'boot-7',
      ticketBootMs: 1000,
      deviceWallClockAt: '2026-11-21T08:00:00+00:00',
    );
    test('same boot, within 16 h: capture allowed', () {
      expect(
        ticket.canCaptureAt(
          const BootReading(bootId: 'boot-7', elapsedMs: 1000),
        ),
        isTrue,
      );
      expect(
        ticket.canCaptureAt(
          BootReading(
            bootId: 'boot-7',
            elapsedMs: 1000 + OfflineLimits.maxCaptureAge.inMilliseconds,
          ),
        ),
        isTrue,
      );
    });
    test(
      'after 16 h, before the ticket, after a reboot, or with no reading: refused',
      () {
        expect(
          ticket.canCaptureAt(
            BootReading(
              bootId: 'boot-7',
              elapsedMs: 1001 + OfflineLimits.maxCaptureAge.inMilliseconds,
            ),
          ),
          isFalse,
        );
        expect(
          ticket.canCaptureAt(
            const BootReading(bootId: 'boot-7', elapsedMs: 999),
          ),
          isFalse,
        );
        expect(
          ticket.canCaptureAt(
            const BootReading(bootId: 'boot-8', elapsedMs: 5000),
          ),
          isFalse,
        );
        expect(ticket.canCaptureAt(null), isFalse);
      },
    );
    test('a malformed stored ticket reads as none', () {
      expect(StoredOfflineTicket.tryFromJson({'token': 't'}), isNull);
      expect(StoredOfflineTicket.tryFromJson('x'), isNull);
    });
  });

  group('boot clock channel', () {
    const channel = MethodChannel('rab/boot_clock');
    const bootA = '6f1c2b0e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
    const bootB = 'a0b1c2d3-e4f5-4a6b-9c7d-8e9f0a1b2c3d';
    void answer(Object? value) => TestDefaultBinaryMessengerBinding
        .instance
        .defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async => value);
    tearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );

    test('reads the kernel boot_id and elapsedRealtime', () async {
      answer({'bootId': bootA.toUpperCase(), 'elapsedRealtimeMs': 345});
      final reading = await const PlatformBootClock().read();
      expect(reading?.bootId, bootA);
      expect(reading?.elapsedMs, 345);
    });

    test(
      'no handler, null, a malformed answer, or the old writable BOOT_COUNT shape: no reading (fail closed)',
      () async {
        expect(await const PlatformBootClock().read(), isNull);
        for (final value in <Object?>[
          null,
          {'bootCount': 12, 'elapsedRealtimeMs': 1},
          {'bootId': '12', 'elapsedRealtimeMs': 1},
          {'bootId': '', 'elapsedRealtimeMs': 1},
          {'bootId': bootA, 'elapsedRealtimeMs': -5},
          {'bootId': bootA, 'elapsedRealtimeMs': '1'},
        ]) {
          answer(value);
          expect(
            await const PlatformBootClock().read(),
            isNull,
            reason: '$value',
          );
        }
      },
    );

    test(
      'security review M1: after a reboot, a reading whose uptime has caught up with the ticket is still refused',
      () async {
        // Ticket received 1 h after boot A.
        answer({'bootId': bootA, 'elapsedRealtimeMs': 3600000});
        final atTicket = await const PlatformBootClock().read();
        final ticket = StoredOfflineTicket(
          token: 't',
          bootId: atTicket!.bootId,
          ticketBootMs: atTicket.elapsedMs,
          deviceWallClockAt: '2026-11-21T08:00:00+00:00',
        );
        // The phone reboots and runs 1 h 1 min. With BOOT_COUNT rewritten (`adb shell settings put global boot_count`)
        // this looked like "1 minute after the ticket, same boot", anchoring a late clock-in near the ticket time. The
        // kernel boot_id cannot be rewritten, so the boot change is always visible.
        answer({'bootId': bootB, 'elapsedRealtimeMs': 3660000});
        final later = await const PlatformBootClock().read();
        expect(later!.bootId, isNot(ticket.bootId));
        expect(ticket.canCaptureAt(later), isFalse);
      },
    );
  });
}
