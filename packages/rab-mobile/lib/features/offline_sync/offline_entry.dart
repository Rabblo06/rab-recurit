import 'package:flutter/foundation.dart';

import 'boot_clock.dart';
import 'canonical_json.dart';

/// The five queueable actions (DESIGN §3.1). Geofence-exit auto clock-out is never queued (D14), and nothing else
/// (offers, profile, ...) is.
enum OfflinePunchType {
  checkIn('check_in'),
  clockIn('clock_in'),
  breakStart('break_start'),
  breakEnd('break_end'),
  clockOut('clock_out');

  const OfflinePunchType(this.wire);
  final String wire;

  static OfflinePunchType fromWire(Object? value) => values.firstWhere(
    (t) => t.wire == value,
    orElse: () => throw FormatException('Unknown offline punch type: $value'),
  );
}

/// A location fix captured offline (DESIGN §5.1). `fixBootMs` is the boot clock at the fix, so the server judges
/// freshness against the anchored punch time; `mock` is the platform's mock-provider flag. Never a wall-clock time.
@immutable
class OfflineLocation {
  const OfflineLocation({
    required this.lat,
    required this.lng,
    required this.accuracyM,
    required this.fixBootMs,
    required this.mock,
  });

  final double lat, lng, accuracyM;
  final int fixBootMs;
  final bool mock;

  Map<String, Object?> toJson() => {
    'lat': lat,
    'lng': lng,
    'accuracyM': accuracyM,
    'fixBootMs': fixBootMs,
    'mock': mock,
  };

  factory OfflineLocation.fromJson(Map<String, Object?> json) =>
      OfflineLocation(
        lat: _double(json['lat']),
        lng: _double(json['lng']),
        accuracyM: _double(json['accuracyM']),
        fixBootMs: _int(json['fixBootMs']),
        mock: json['mock'] as bool,
      );
}

/// DESIGN §3.2 `integrity`: `rootedSignal` is a client-asserted hint (a rooted phone can hide it), recorded as a flag
/// on the receipt and never used to block (§6.4).
@immutable
class OfflineIntegrity {
  const OfflineIntegrity({required this.rootedSignal});
  final bool rootedSignal;

  Map<String, Object?> toJson() => {'rootedSignal': rootedSignal};

  factory OfflineIntegrity.fromJson(Object? json) {
    if (json is! Map || json['rootedSignal'] is! bool) {
      throw const FormatException('Missing integrity.rootedSignal');
    }
    return OfflineIntegrity(rootedSignal: json['rootedSignal'] as bool);
  }
}

/// Fields that must NEVER appear in an entry (DESIGN §3.2): the server derives all of them, and a body carrying any
/// of them is a 400 (`forbidNonWhitelisted`). Tests assert none is ever written.
const Set<String> kForbiddenEntryFields = {
  'organisationId',
  'workspaceId',
  'staffProfileId',
  'userId',
  'status',
  'clockInAt',
  'clockOutAt',
  'workedMinutes',
  'earnedPence',
  'payRatePence',
  'payRateSnapshotPence',
  'amountPence',
};

/// One queued punch exactly as it goes over the wire (DESIGN §3.2). Immutable: once signed, any change would break
/// the signature (§6.2).
@immutable
class OfflineEntry {
  const OfflineEntry({
    required this.idempotencyKey,
    required this.clientSeq,
    required this.type,
    required this.shiftId,
    required this.ticket,
    required this.bootId,
    required this.ticketBootMs,
    required this.punchBootId,
    required this.punchBootMs,
    required this.deviceWallClockAt,
    required this.integrity,
    this.qrToken,
    this.location,
    required this.appVersion,
    this.deviceKeyId,
    this.sig,
  });

  static const int version = 1;

  /// UUID v4 generated on the phone at the tap; the same key the online attempt carried (D17).
  final String idempotencyKey;

  /// Per-install counter, strictly increasing, never reused. Replay order.
  final int clientSeq;
  final OfflinePunchType type;

  /// Always present (never "the current shift", arch §13).
  final String shiftId;

  /// The server-signed offline ticket held at capture time, and the boot reading when it was received.
  final String ticket;
  final String bootId;
  final int ticketBootMs;

  /// The boot reading at the punch.
  final String punchBootId;
  final int punchBootMs;

  /// The phone's wall clock at the punch (ISO-8601 with offset). Diagnostics only: the server uses it for the
  /// `clock_skew` flag (§4.5), NEVER as a time.
  final String deviceWallClockAt;

  /// Client-asserted integrity signal (D11, §6.4): a flag on the receipt only, never a block.
  final OfflineIntegrity integrity;

  /// The scanned QR text verbatim (clock_in / clock_out; optional for check_in). The phone cannot verify it.
  final String? qrToken;
  final OfflineLocation? location;
  final String appVersion;

  /// The registered device key that signed this entry, and the signature. Both null only in tests of unsigned
  /// shapes: the queue never stores an entry the signer could not sign (see `entry_signer.dart`).
  final String? deviceKeyId;
  final String? sig;

  /// Every field except `sig`, absent optionals omitted (not null), in the shape that is signed and hashed.
  Map<String, Object?> signedFields() => {
    'v': version,
    'idempotencyKey': idempotencyKey,
    'clientSeq': clientSeq,
    'type': type.wire,
    'shiftId': shiftId,
    'ticket': ticket,
    'bootId': bootId,
    'ticketBootMs': ticketBootMs,
    'punchBootId': punchBootId,
    'punchBootMs': punchBootMs,
    'deviceWallClockAt': deviceWallClockAt,
    'qrToken': ?qrToken,
    if (location != null) 'location': location!.toJson(),
    'integrity': integrity.toJson(),
    'appVersion': appVersion,
    'deviceKeyId': ?deviceKeyId,
  };

  /// The bytes the device key signs (RFC 8785 canonical JSON, UTF-8).
  List<int> signingPayload() => canonicalJsonBytes(signedFields());

  /// The entry as sent in `POST /attendance/me/sync` `entries[]`.
  Map<String, Object?> toWireJson() => {...signedFields(), 'sig': ?sig};

  OfflineEntry withSignature(String signature) => OfflineEntry(
    idempotencyKey: idempotencyKey,
    clientSeq: clientSeq,
    type: type,
    shiftId: shiftId,
    ticket: ticket,
    bootId: bootId,
    ticketBootMs: ticketBootMs,
    punchBootId: punchBootId,
    punchBootMs: punchBootMs,
    deviceWallClockAt: deviceWallClockAt,
    integrity: integrity,
    qrToken: qrToken,
    location: location,
    appVersion: appVersion,
    deviceKeyId: deviceKeyId,
    sig: signature,
  );

  /// Strict: anything unexpected throws [FormatException] (the queue then reports itself unreadable rather than
  /// sending a guess).
  factory OfflineEntry.fromWireJson(Map<String, Object?> json) {
    if (json['v'] != version) {
      throw FormatException('Unsupported offline entry version: ${json['v']}');
    }
    final location = json['location'];
    return OfflineEntry(
      idempotencyKey: json['idempotencyKey'] as String,
      clientSeq: _int(json['clientSeq']),
      type: OfflinePunchType.fromWire(json['type']),
      shiftId: json['shiftId'] as String,
      ticket: json['ticket'] as String,
      bootId: json['bootId'] as String,
      ticketBootMs: _int(json['ticketBootMs']),
      punchBootId: json['punchBootId'] as String,
      punchBootMs: _int(json['punchBootMs']),
      deviceWallClockAt: json['deviceWallClockAt'] as String,
      integrity: OfflineIntegrity.fromJson(json['integrity']),
      qrToken: json['qrToken'] as String?,
      location: location == null
          ? null
          : OfflineLocation.fromJson((location as Map).cast<String, Object?>()),
      appVersion: json['appVersion'] as String,
      deviceKeyId: json['deviceKeyId'] as String?,
      sig: json['sig'] as String?,
    );
  }

  /// UX only (the server decides with `SYNC_TOO_LATE`): how long ago this entry was captured. Measured on the boot
  /// clock while the phone has not rebooted, otherwise on the wall clock (never negative).
  Duration ageAt(BootReading? now, DateTime deviceNow) {
    final boot = now?.elapsedSince(punchBootId, punchBootMs);
    if (boot != null && boot >= 0) return Duration(milliseconds: boot);
    final captured = DateTime.tryParse(deviceWallClockAt);
    if (captured == null) return Duration.zero;
    final wall = deviceNow.difference(captured);
    return wall.isNegative ? Duration.zero : wall;
  }
}

/// Where a queued punch stands on this phone. `applied` / `duplicate` / `replayed` outcomes are not states: those
/// entries are deleted as soon as the server acknowledges them (DESIGN §3.5).
enum QueuedPunchState {
  /// Waiting to send.
  pending,

  /// The server refused it (per-item `rejected`); kept until the staff member dismisses it.
  rejected,

  /// Older than [OfflineLimits.maxSyncDelay]; never sent. Kept until dismissed.
  tooOld,

  /// The server refused it as malformed even when sent alone (a client bug). Never resent. Kept until dismissed.
  parked,
}

/// A queued entry plus what only this phone needs to know about it. Nothing here except [entry] is ever sent.
@immutable
class QueuedPunch {
  const QueuedPunch({
    required this.entry,
    required this.displayAt,
    this.state = QueuedPunchState.pending,
    this.code,
    this.qrReason,
  });

  final OfflineEntry entry;

  /// The time shown on screen ("saved on this phone at 09:02"): the server-anchored estimate at the tap when one was
  /// available. Display only; the server decides the recorded time.
  final DateTime displayAt;
  final QueuedPunchState state;

  /// The server's per-item rejection code (DESIGN §4.6), when [state] is [QueuedPunchState.rejected].
  final String? code;

  /// `INVALID_QR` detail (`invalid|expired|shift_mismatch|venue_mismatch|revoked|issued_after_punch`).
  final String? qrReason;

  String get idempotencyKey => entry.idempotencyKey;
  bool get isPending => state == QueuedPunchState.pending;

  QueuedPunch withState(
    QueuedPunchState state, {
    String? code,
    String? qrReason,
  }) => QueuedPunch(
    entry: entry,
    displayAt: displayAt,
    state: state,
    code: code,
    qrReason: qrReason,
  );

  Map<String, Object?> toStoreJson() => {
    'entry': entry.toWireJson(),
    'displayAt': displayAt.toUtc().toIso8601String(),
    'state': state.name,
    'code': ?code,
    'qrReason': ?qrReason,
  };

  factory QueuedPunch.fromStoreJson(Map<String, Object?> json) => QueuedPunch(
    entry: OfflineEntry.fromWireJson(
      (json['entry'] as Map).cast<String, Object?>(),
    ),
    displayAt: DateTime.parse(json['displayAt'] as String),
    state: QueuedPunchState.values.byName(json['state'] as String),
    code: json['code'] as String?,
    qrReason: json['qrReason'] as String?,
  );
}

/// ISO-8601 with the device's own offset (`2026-11-21T09:02:11+01:00`), for the diagnostics-only wall-clock fields.
String deviceWallClockIso(DateTime local) {
  final offset = local.timeZoneOffset;
  final sign = offset.isNegative ? '-' : '+';
  final abs = offset.abs();
  String two(int n) => n.toString().padLeft(2, '0');
  final base = DateTime(
    local.year,
    local.month,
    local.day,
    local.hour,
    local.minute,
    local.second,
  ).toIso8601String().substring(0, 19);
  return '$base$sign${two(abs.inHours)}:${two(abs.inMinutes % 60)}';
}

double _double(Object? value) => switch (value) {
  final num n => n.toDouble(),
  _ => throw FormatException('Expected a number, got $value'),
};

int _int(Object? value) => switch (value) {
  final int n => n,
  _ => throw FormatException('Expected an integer, got $value'),
};
