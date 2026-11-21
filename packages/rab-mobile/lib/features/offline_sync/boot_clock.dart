import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// One reading of the phone's boot clock (DESIGN §3.3, §4.2): which boot session, and the milliseconds since boot
/// INCLUDING deep sleep.
@immutable
class BootReading {
  const BootReading({required this.bootId, required this.elapsedMs});
  final String bootId;
  final int elapsedMs;

  /// Milliseconds from [earlier] to this reading, or null when the phone rebooted in between (the two readings are
  /// then on different clocks and cannot be compared).
  int? elapsedSince(String earlierBootId, int earlierMs) =>
      bootId == earlierBootId ? elapsedMs - earlierMs : null;
}

/// The boot clock the offline queue measures elapsed time with. Never Dart's [Stopwatch]: on Android that is
/// `CLOCK_MONOTONIC`, which stops in deep sleep, so an offline clock-in would look EARLIER than it was (more pay).
abstract class BootClock {
  /// Null when the platform cannot say (no channel, an unsupported platform, an error). Callers fail closed: no
  /// reading means nothing is queued.
  Future<BootReading?> read();
}

/// Android: `SystemClock.elapsedRealtime()` (counts deep sleep) and `Settings.Global.BOOT_COUNT`, from the
/// `rab/boot_clock` channel in `MainActivity.kt`. Every other platform (and a missing handler) answers null.
class PlatformBootClock implements BootClock {
  const PlatformBootClock();

  static const channel = MethodChannel('rab/boot_clock');

  @override
  Future<BootReading?> read() async {
    try {
      final result = await channel.invokeMapMethod<String, Object?>('read');
      final bootCount = result?['bootCount'];
      final elapsed = result?['elapsedRealtimeMs'];
      if (bootCount is! int ||
          bootCount < 0 ||
          elapsed is! int ||
          elapsed < 0) {
        return null;
      }
      return BootReading(bootId: 'boot-$bootCount', elapsedMs: elapsed);
    } catch (_) {
      return null;
    }
  }
}
