import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/core/services/location_service.dart';
import 'package:rab_staff/features/offline_sync/offline_config.dart';
import 'package:rab_staff/features/offline_sync/offline_entry.dart';
import 'package:rab_staff/features/offline_sync/offline_messages.dart';
import 'package:rab_staff/features/offline_sync/offline_queue_store.dart';
import 'package:rab_staff/features/offline_sync/offline_sync_controller.dart';

import 'support/biometric_test_support.dart';
import 'support/offline_test_support.dart';

/// M4 offline queue, PR 2: when a punch may be saved on this phone, and what is saved (DESIGN §3.1–§3.4, D5, D18).
/// Offline mode is OFF in every real build (owner HARD RULE); these tests switch it on only through the injected build
/// flag and a fake device-key signer.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secure;
  late FakeBootClock boot;
  late FakeEntrySigner signer;
  late DateTime wallNow;

  setUp(() {
    secure = {};
    stubSecureStorageChannel(secure);
    boot = FakeBootClock();
    signer = FakeEntrySigner();
    wallNow = DateTime.utc(2026, 11, 21, 9);
  });
  tearDown(clearSecureStorageChannel);

  OfflineSyncController controller({
    String userId = 'user-a',
    bool buildFlag = true,
    FakeEntrySigner? withSigner,
  }) => OfflineSyncController(
    userId: userId,
    bootClock: boot,
    signer: withSigner ?? signer,
    buildFlag: buildFlag,
    deviceNow: () => wallNow,
  );

  Map<String, dynamic> active({
    Object? enabled = true,
    Object? ticket = 'tkt',
  }) => {
    'attendance': null,
    'serverNow': '2026-11-21T09:00:00.000Z',
    'offline': {'enabled': enabled},
    'offlineTicket': ticket,
  };

  Future<OfflineSyncController> enabled({String userId = 'user-a'}) async {
    final c = controller(userId: userId);
    await c.ready;
    await c.ingestActive(active(), fetchDuration: const Duration(seconds: 1));
    return c;
  }

  Future<OfflineCaptureResult> clockIn(
    OfflineSyncController c, {
    String shiftId = 'shift-1',
    String? key,
    LocationFix? location,
  }) => c.capture(
    type: OfflinePunchType.clockIn,
    shiftId: shiftId,
    idempotencyKey: key ?? c.newIdempotencyKey(),
    qrToken: 'qr-text',
    location: location,
    displayAt: DateTime.utc(2026, 11, 21, 9, 2),
  );

  group('off unless every switch is on (HARD RULE)', () {
    test(
      'the build flag defaults off: never queues, never stores a ticket',
      () async {
        final c = controller(buildFlag: false);
        await c.ingestActive(active(), fetchDuration: Duration.zero);
        expect(c.serverEnabled, isFalse);
        expect(c.mayQueue, isFalse);
        expect((await clockIn(c)).outcome, OfflineCaptureOutcome.notEnabled);
        expect(secure.keys.where((k) => k.startsWith('rab.offline.')), isEmpty);
      },
    );

    test('the default controller (real build) never queues', () async {
      final c = OfflineSyncController(userId: 'u', bootClock: boot);
      await c.ingestActive(active(), fetchDuration: Duration.zero);
      expect(kOfflineAttendanceBuildFlag, isFalse);
      expect(c.mayQueue, isFalse);
    });

    test(
      'only offline.enabled == true (exactly) turns the server switch on',
      () async {
        for (final value in <Object?>['true', 1, null, false]) {
          final c = controller();
          await c.ingestActive(
            active(enabled: value),
            fetchDuration: Duration.zero,
          );
          expect(c.serverEnabled, isFalse, reason: '$value');
          expect(c.mayQueue, isFalse);
        }
        final c = controller();
        await c.ingestActive({
          'attendance': null,
        }, fetchDuration: Duration.zero);
        expect(c.mayQueue, isFalse, reason: 'an older server sends nothing');
      },
    );

    test('no registered device key: never queues', () async {
      final c = controller(withSigner: FakeEntrySigner(available: false));
      await c.ingestActive(active(), fetchDuration: Duration.zero);
      expect(c.mayQueue, isFalse);
      final noKey = controller(withSigner: FakeEntrySigner(deviceKeyId: null));
      await noKey.ingestActive(active(), fetchDuration: Duration.zero);
      expect(noKey.mayQueue, isFalse);
    });

    test('the server switching off deletes the stored ticket', () async {
      final c = await enabled();
      expect(secure.containsKey(OfflineQueueStore.ticketKey('user-a')), isTrue);
      await c.ingestActive(
        active(enabled: false),
        fetchDuration: Duration.zero,
      );
      expect(c.mayQueue, isFalse);
      expect(
        secure.containsKey(OfflineQueueStore.ticketKey('user-a')),
        isFalse,
      );
    });

    test(
      'a ticket fetched in more than 10 s is thrown away (the previous one is kept)',
      () async {
        final c = controller();
        await c.ingestActive(
          active(ticket: 'slow'),
          fetchDuration: const Duration(seconds: 11),
        );
        expect(c.mayQueue, isFalse);
        await c.ingestActive(
          active(ticket: 'fast'),
          fetchDuration: Duration.zero,
        );
        await c.ingestActive(
          active(ticket: 'slow'),
          fetchDuration: const Duration(seconds: 11),
        );
        final stored = jsonDecode(
          secure[OfflineQueueStore.ticketKey('user-a')]!,
        );
        expect(stored['token'], 'fast');
      },
    );

    test('no boot clock reading: no ticket, nothing queued', () async {
      boot.unavailable = true;
      final c = controller();
      await c.ingestActive(active(), fetchDuration: Duration.zero);
      expect(c.mayQueue, isFalse);
    });
  });

  group('capture (§3.2)', () {
    test(
      'a queued entry carries the ticket, boot readings and a signature over its canonical bytes',
      () async {
        final c = await enabled();
        boot.advance(const Duration(minutes: 30));
        final key = c.newIdempotencyKey();
        final result = await clockIn(
          c,
          key: key,
          location: LocationFix(
            lat: 51.5,
            lng: -0.12,
            accuracyM: 14,
            capturedAt: DateTime.utc(2026, 11, 21, 9, 30),
            age: const Duration(seconds: 3),
            mock: true,
          ),
        );
        expect(result.queued, isTrue);
        final entry = result.punch!.entry;
        expect(entry.idempotencyKey, key);
        expect(entry.type, OfflinePunchType.clockIn);
        expect(entry.shiftId, 'shift-1');
        expect(entry.ticket, 'tkt');
        expect(entry.bootId, 'boot-7');
        expect(entry.punchBootId, 'boot-7');
        expect(entry.punchBootMs - entry.ticketBootMs, 30 * 60 * 1000);
        expect(entry.location!.fixBootMs, entry.punchBootMs - 3000);
        expect(entry.location!.mock, isTrue);
        expect(entry.deviceKeyId, 'dk-1');
        expect(signer.signed.single, entry.withSignature('x').signingPayload());
        expect(entry.sig, isNotEmpty);
        expect(
          entry.toWireJson().keys.toSet().intersection(kForbiddenEntryFields),
          isEmpty,
        );
        expect(result.punch!.displayAt, DateTime.utc(2026, 11, 21, 9, 2));
        expect(c.pendingCount, 1);
        expect(c.hasUnsent, isTrue);
        expect(c.pendingFor('shift-1', OfflinePunchType.clockIn), isNotNull);
        expect(c.pendingClockInShiftId, 'shift-1');
        // Persisted, encrypted at rest, under this user's key only.
        expect(
          secure.containsKey(OfflineQueueStore.queueKey('user-a')),
          isTrue,
        );
      },
    );

    test(
      'the rooted-phone hint is recorded on the entry (a flag, never a refusal)',
      () async {
        final c = OfflineSyncController(
          userId: 'user-r',
          bootClock: boot,
          signer: signer,
          buildFlag: true,
          rootedSignal: () => true,
        );
        await c.ingestActive(active(), fetchDuration: Duration.zero);
        final result = await clockIn(c);
        expect(result.queued, isTrue);
        expect(result.punch!.entry.integrity.rootedSignal, isTrue);
        expect(result.punch!.entry.toWireJson()['integrity'], {
          'rootedSignal': true,
        });
      },
    );

    test('clientSeq increases across captures', () async {
      final c = await enabled();
      final a = await clockIn(c);
      final b = await c.capture(
        type: OfflinePunchType.clockOut,
        shiftId: 'shift-1',
        idempotencyKey: c.newIdempotencyKey(),
        qrToken: 'qr',
      );
      expect(b.punch!.entry.clientSeq, greaterThan(a.punch!.entry.clientSeq));
      expect(c.pendingClockInShiftId, isNull);
    });

    test(
      'a reboot since the ticket, or more than 16 h after it: refused ("Connect once")',
      () async {
        final c = await enabled();
        boot.advance(OfflineLimits.maxCaptureAge + const Duration(seconds: 1));
        final late = await clockIn(c);
        expect(late.outcome, OfflineCaptureOutcome.needsTicket);
        expect(late.message, OfflineMessages.needsTicket);
        final r = await enabled(userId: 'user-r');
        boot.reboot();
        expect((await clockIn(r)).outcome, OfflineCaptureOutcome.needsTicket);
        expect(r.entries, isEmpty);
      },
    );

    test(
      'UX dependency checks: no clock-out without a clock-in; no duplicate of a saved action',
      () async {
        final c = await enabled();
        final out = await c.capture(
          type: OfflinePunchType.clockOut,
          shiftId: 'shift-1',
          idempotencyKey: c.newIdempotencyKey(),
        );
        expect(out.outcome, OfflineCaptureOutcome.notClockedIn);
        // With the server's open attendance it is allowed.
        final withActive = await c.capture(
          type: OfflinePunchType.clockOut,
          shiftId: 'shift-1',
          idempotencyKey: c.newIdempotencyKey(),
          activeShiftId: 'shift-1',
        );
        expect(withActive.queued, isTrue);
        final dup = await c.capture(
          type: OfflinePunchType.clockOut,
          shiftId: 'shift-1',
          idempotencyKey: c.newIdempotencyKey(),
          activeShiftId: 'shift-1',
        );
        expect(dup.outcome, OfflineCaptureOutcome.alreadySaved);
      },
    );

    test('the device key failing to sign: nothing is stored', () async {
      final failing = _FailingSigner();
      final c = controller(withSigner: failing);
      await c.ingestActive(active(), fetchDuration: Duration.zero);
      final result = await clockIn(c);
      expect(result.outcome, OfflineCaptureOutcome.failed);
      expect(c.entries, isEmpty);
      expect(secure.containsKey(OfflineQueueStore.queueKey('user-a')), isFalse);
    });

    test('a full queue refuses with the §3.4 text', () async {
      final c = await enabled();
      for (var i = 0; i < OfflineLimits.maxEntries; i++) {
        expect((await clockIn(c, shiftId: 'shift-$i')).queued, isTrue);
      }
      final full = await clockIn(c, shiftId: 'shift-x');
      expect(full.outcome, OfflineCaptureOutcome.full);
      expect(full.message, OfflineMessages.queueFull);
    });

    test(
      'a different user on the same phone never sees the previous user\'s queue',
      () async {
        final a = await enabled();
        await clockIn(a);
        final b = await enabled(userId: 'user-b');
        expect(b.entries, isEmpty);
        expect(b.hasUnsent, isFalse);
        // And A's queue survives B's session untouched.
        final again = controller();
        await again.ready;
        expect(again.entries, hasLength(1));
      },
    );
  });

  group('age, dismissal, discard, logout (D5, D18)', () {
    test(
      'an entry older than 72 h is marked too old and never pending again',
      () async {
        final c = await enabled();
        await clockIn(c);
        boot.advance(OfflineLimits.maxSyncDelay + const Duration(minutes: 1));
        await c.markTooOld();
        expect(c.entries.single.state, QueuedPunchState.tooOld);
        expect(c.hasUnsent, isFalse);
        expect(c.needsAttention, isTrue);
      },
    );

    test('dismiss removes a refused entry, never a pending one', () async {
      final c = await enabled();
      final r = await clockIn(c);
      await c.dismiss(r.punch!.idempotencyKey);
      expect(c.entries, hasLength(1), reason: 'pending cannot be dismissed');
      await OfflineQueueStore().update(
        'user-a',
        (all) => [all.single.withState(QueuedPunchState.rejected, code: 'X_Y')],
      );
      final reloaded = controller();
      await reloaded.ready;
      await reloaded.dismiss(r.punch!.idempotencyKey);
      expect(reloaded.entries, isEmpty);
    });

    test(
      'logout is refused while punches are unsent; discardAll clears queue and ticket',
      () async {
        final c = await enabled();
        await clockIn(c);
        expect(await c.clearForLogout(), isFalse);
        expect(c.entries, hasLength(1));
        await c.discardAll();
        expect(c.entries, isEmpty);
        expect(secure.keys.where((k) => k.contains('user-a')), isEmpty);
        expect(await c.clearForLogout(), isTrue);
      },
    );

    test(
      'logout with only results left deletes them (nothing stays at rest)',
      () async {
        final c = await enabled();
        await clockIn(c);
        boot.advance(OfflineLimits.maxSyncDelay + const Duration(minutes: 1));
        await c.markTooOld();
        expect(await c.clearForLogout(), isTrue);
        expect(secure.keys.where((k) => k.contains('user-a')), isEmpty);
      },
    );
  });

  group('isNoResponseFailure (§3.1)', () {
    test('no response at all, or a timeout: may be queued', () {
      expect(isNoResponseFailure(const SocketException('down')), isTrue);
      expect(isNoResponseFailure(http.ClientException('down')), isTrue);
      expect(isNoResponseFailure(TimeoutException('slow')), isTrue);
      expect(isNoResponseFailure(ApiException(408, 'timeout')), isTrue);
    });
    test('any HTTP response, a 5xx included: never queued', () {
      for (final status in [400, 401, 403, 404, 409, 429, 500, 503]) {
        expect(isNoResponseFailure(ApiException(status, 'x')), isFalse);
      }
      expect(isNoResponseFailure(StateError('bug')), isFalse);
    });
  });
}

class _FailingSigner extends FakeEntrySigner {
  @override
  Future<String?> sign(List<int> payload) async => null;
}
