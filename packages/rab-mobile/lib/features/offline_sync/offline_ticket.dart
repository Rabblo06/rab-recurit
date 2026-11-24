import 'package:flutter/foundation.dart';

import 'boot_clock.dart';
import 'offline_config.dart';

/// The server-signed offline ticket (DESIGN §4.2) as this phone holds it: the opaque token (the phone never parses or
/// trusts its claims; only the server verifies it) and the boot reading taken when it arrived.
@immutable
class StoredOfflineTicket {
  const StoredOfflineTicket({
    required this.token,
    required this.bootId,
    required this.ticketBootMs,
    required this.deviceWallClockAt,
  });

  final String token;
  final String bootId;
  final int ticketBootMs;

  /// The phone's wall clock when the ticket arrived (diagnostics only, for the server's `clock_changed` flag).
  final String deviceWallClockAt;

  /// Whether a punch at [now] may still be captured against this ticket: same boot session (a reboot breaks the
  /// boot-clock link), not before the ticket, and no more than [OfflineLimits.maxCaptureAge] after it (§3.4). Fails
  /// closed on a missing reading.
  bool canCaptureAt(BootReading? now) {
    if (now == null) return false;
    final elapsed = now.elapsedSince(bootId, ticketBootMs);
    return elapsed != null &&
        elapsed >= 0 &&
        elapsed <= OfflineLimits.maxCaptureAge.inMilliseconds;
  }

  Map<String, Object?> toJson() => {
    'token': token,
    'bootId': bootId,
    'ticketBootMs': ticketBootMs,
    'deviceWallClockAt': deviceWallClockAt,
  };

  static StoredOfflineTicket? tryFromJson(Object? json) {
    if (json is! Map) return null;
    final token = json['token'], bootId = json['bootId'];
    final ms = json['ticketBootMs'], wall = json['deviceWallClockAt'];
    if (token is! String || token.isEmpty || bootId is! String) return null;
    if (ms is! int || wall is! String) return null;
    return StoredOfflineTicket(
      token: token,
      bootId: bootId,
      ticketBootMs: ms,
      deviceWallClockAt: wall,
    );
  }
}
