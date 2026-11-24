import 'dart:convert';

import 'package:rab_staff/features/offline_sync/boot_clock.dart';
import 'package:rab_staff/features/offline_sync/entry_signer.dart';
import 'package:rab_staff/features/offline_sync/offline_entry.dart';

/// A boot clock the test moves by hand. `null` [reading] = the platform cannot say.
class FakeBootClock implements BootClock {
  FakeBootClock({this.bootId = 'boot-7', this.elapsedMs = 1000000});
  String bootId;
  int elapsedMs;
  bool unavailable = false;

  void advance(Duration d) => elapsedMs += d.inMilliseconds;
  void reboot() {
    bootId = '$bootId-r';
    elapsedMs = 5000;
  }

  @override
  Future<BootReading?> read() async =>
      unavailable ? null : BootReading(bootId: bootId, elapsedMs: elapsedMs);
}

/// A signer that "signs" deterministically (base64url of the payload length + a marker), so tests can see that the
/// signature covers the canonical bytes. Not cryptography: the real key is a Keystore P-256 key (not built yet).
class FakeEntrySigner implements OfflineEntrySigner {
  FakeEntrySigner({this.deviceKeyId = 'dk-1', this.available = true});
  @override
  final String? deviceKeyId;
  bool available;
  final signed = <List<int>>[];

  @override
  bool get isAvailable => available;

  @override
  Future<String?> sign(List<int> payload) async {
    signed.add(payload);
    return base64Url
        .encode(utf8.encode('sig:${payload.length}'))
        .replaceAll('=', '');
  }
}

OfflineEntry sampleEntry({
  String key = '0d6c3c2e-0000-4000-8000-000000000001',
  int seq = 1,
  OfflinePunchType type = OfflinePunchType.clockIn,
  String shiftId = 'shift-1',
  int punchBootMs = 1100000,
  String punchBootId = 'boot-7',
  String deviceWallClockAt = '2026-11-21T09:02:11+00:00',
  String? qrToken = 'qr-text',
  OfflineLocation? location,
  String? sig = 'c2ln',
}) => OfflineEntry(
  idempotencyKey: key,
  clientSeq: seq,
  type: type,
  shiftId: shiftId,
  ticket: 'ticket-jws',
  bootId: 'boot-7',
  ticketBootMs: 1000000,
  punchBootId: punchBootId,
  punchBootMs: punchBootMs,
  deviceWallClockAt: deviceWallClockAt,
  integrity: const OfflineIntegrity(rootedSignal: false),
  qrToken: qrToken,
  location: location,
  appVersion: 'rab-mobile test',
  deviceKeyId: 'dk-1',
  sig: sig,
);

QueuedPunch samplePunch({
  String key = '0d6c3c2e-0000-4000-8000-000000000001',
  int seq = 1,
  OfflinePunchType type = OfflinePunchType.clockIn,
  String shiftId = 'shift-1',
  QueuedPunchState state = QueuedPunchState.pending,
  String? qrToken = 'qr-text',
}) => QueuedPunch(
  entry: sampleEntry(
    key: key,
    seq: seq,
    type: type,
    shiftId: shiftId,
    qrToken: qrToken,
  ),
  displayAt: DateTime.utc(2026, 11, 21, 9, 2),
  state: state,
);

String keyFor(int n) =>
    '0d6c3c2e-0000-4000-8000-${n.toString().padLeft(12, '0')}';
