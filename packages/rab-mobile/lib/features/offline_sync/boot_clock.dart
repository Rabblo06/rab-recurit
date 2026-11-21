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

/// Android: `SystemClock.elapsedRealtime()` (counts deep sleep) and the kernel's per-boot random UUID
/// (`/proc/sys/kernel/random/boot_id`), from the `rab/boot_clock` channel in `MainActivity.kt`. The boot identity must be
/// one nobody can write: `Settings.Global.BOOT_COUNT` is NOT used, because `adb shell settings put global boot_count N`
/// rewrites it without root, which would let a reboot pass as the same boot session (security review M1). Anything
/// but a well-formed UUID, every other platform, and a missing handler answer null (nothing can be queued).
class PlatformBootClock implements BootClock {
  const PlatformBootClock();

  static const channel = MethodChannel('rab/boot_clock');

  static final _kernelBootId = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  );

  @override
  Future<BootReading?> read() async {
    try {
      final result = await channel.invokeMapMethod<String, Object?>('read');
      final bootId = result?['bootId'];
      final elapsed = result?['elapsedRealtimeMs'];
      if (bootId is! String ||
          !_kernelBootId.hasMatch(bootId) ||
          elapsed is! int ||
          elapsed < 0) {
        return null;
      }
      return BootReading(bootId: bootId.toLowerCase(), elapsedMs: elapsed);
    } catch (_) {
      return null;
    }
  }
}
