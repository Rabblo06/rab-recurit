import 'dart:async';
import 'dart:io' show HandshakeException, SocketException;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../../core/api/api_client.dart';
import '../../core/push/push_device_store.dart';
import '../../core/services/location_service.dart';
import 'boot_clock.dart';
import 'entry_signer.dart';
import 'offline_config.dart';
import 'offline_entry.dart';
import 'offline_messages.dart';
import 'offline_queue_store.dart';
import 'offline_ticket.dart';

/// True when a request failed BEFORE any response arrived (DESIGN §3.1): no connectivity, DNS, socket or TLS failure,
/// or a timeout (an uncertain outcome: the same idempotency key is reused, so the server either reports the first
/// attempt as applied or applies it once). Any HTTP response, a 5xx included, is NOT this: it is shown as an error.
bool isNoResponseFailure(Object error) =>
    error is SocketException ||
    error is HandshakeException ||
    error is http.ClientException ||
    error is TimeoutException ||
    (error is ApiException && error.statusCode == 408);

enum OfflineCaptureOutcome {
  queued,
  notEnabled,
  needsTicket,
  full,
  unreadable,
  notClockedIn,
  alreadySaved,
  failed,
}

class OfflineCaptureResult {
  const OfflineCaptureResult(this.outcome, {this.punch, this.message});
  final OfflineCaptureOutcome outcome;
  final QueuedPunch? punch;

  /// Staff text for a refused capture (null when queued).
  final String? message;
  bool get queued => outcome == OfflineCaptureOutcome.queued;
}

/// The offline queue for ONE signed-in staff member (created per session in `app.dart`, keyed by user id, disposed on
/// logout or account switch).
///
/// It only ever holds anything when every switch in `offline_config.dart` is on; today the device-key signer is a
/// placeholder that is never available, so [mayQueue] is always false on a real phone (owner HARD RULE).
class OfflineSyncController extends ChangeNotifier {
  OfflineSyncController({
    required this.userId,
    OfflineQueueStore? store,
    BootClock? bootClock,
    OfflineEntrySigner? signer,
    bool? buildFlag,
    DateTime Function()? deviceNow,
  }) : _store = store ?? OfflineQueueStore(),
       _bootClock = bootClock ?? const PlatformBootClock(),
       _signer = signer ?? const UnavailableEntrySigner(),
       _buildFlag = buildFlag ?? kOfflineAttendanceBuildFlag,
       _deviceNow = deviceNow ?? DateTime.now {
    ready = _restore();
  }

  final String userId;
  final OfflineQueueStore _store;
  final BootClock _bootClock;
  final OfflineEntrySigner _signer;
  final bool _buildFlag;
  final DateTime Function() _deviceNow;

  /// Completes once the stored queue and ticket have been read.
  late final Future<void> ready;
  bool _disposed = false;

  /// What the last `GET /attendance/me/active` said (`offline.enabled == true` exactly). Off until then.
  bool serverEnabled = false;
  StoredOfflineTicket? _ticket;
  List<QueuedPunch> _entries = const [];

  /// A stored queue exists but cannot be read (nothing in it can be sent; see [OfflineQueueSnapshot.unreadable]).
  bool unreadable = false;

  List<QueuedPunch> get entries => _entries;
  Iterable<QueuedPunch> get pending => _entries.where((e) => e.isPending);
  int get pendingCount => pending.length;

  /// D18: logout is blocked while this is true.
  bool get hasUnsent => pendingCount > 0;

  /// Entries the staff member should look at (refused, too old, could not send) or an unreadable queue.
  bool get needsAttention => unreadable || _entries.any((e) => !e.isPending);

  /// Whether a failed punch may be saved on this phone instead (synchronous pre-check; [capture] re-checks the boot
  /// clock and the ticket age).
  bool get mayQueue =>
      _buildFlag &&
      serverEnabled &&
      _ticket != null &&
      _signer.isAvailable &&
      _signer.deviceKeyId != null &&
      !unreadable;

  /// A fresh UUID v4 for one tap; the online attempt and its queued fallback share it (D17).
  String newIdempotencyKey() => PushDeviceStore.generateUuidV4();

  /// The latest pending entry of [type] for [shiftId], if any.
  QueuedPunch? pendingFor(String? shiftId, OfflinePunchType type) {
    if (shiftId == null) return null;
    return pending
        .where((e) => e.entry.shiftId == shiftId && e.entry.type == type)
        .lastOrNull;
  }

  /// The shift a pending clock-in is waiting for, when its clock-out has not been saved yet.
  String? get pendingClockInShiftId {
    for (final e in pending.toList().reversed) {
      if (e.entry.type == OfflinePunchType.clockIn &&
          pendingFor(e.entry.shiftId, OfflinePunchType.clockOut) == null) {
        return e.entry.shiftId;
      }
    }
    return null;
  }

  Future<void> _restore() async {
    try {
      final snapshot = await _store.load(userId);
      _entries = snapshot.entries;
      unreadable = snapshot.unreadable;
      _ticket = _buildFlag ? await _store.loadTicket(userId) : null;
      await markTooOld();
    } catch (_) {
      // Secure storage unavailable: nothing is queued (mayQueue needs a ticket), nothing is lost.
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Reads the offline settings and ticket from a successful `GET /attendance/me/active` (DESIGN §3.1, §4.2).
  /// [fetchDuration] is how long that request took: a ticket fetched in more than 10 s is thrown away (the previous
  /// one, if any, is kept). When the build flag or the server says off, any stored ticket is deleted.
  Future<void> ingestActive(
    Map<String, dynamic> data, {
    required Duration fetchDuration,
  }) async {
    // A build without the offline flag does nothing here at all: no platform call, no storage write.
    if (!_buildFlag) {
      serverEnabled = false;
      return;
    }
    final reading = await _bootClock.read();
    await ready;
    final offline = data['offline'];
    serverEnabled = _buildFlag && offline is Map && offline['enabled'] == true;
    try {
      if (!serverEnabled) {
        if (_ticket != null) {
          _ticket = null;
          await _store.deleteTicket(userId);
        }
      } else {
        final token = data['offlineTicket'];
        if (token is String &&
            token.isNotEmpty &&
            token.length <= 4096 &&
            reading != null &&
            fetchDuration <= OfflineLimits.maxTicketFetch) {
          final ticket = StoredOfflineTicket(
            token: token,
            bootId: reading.bootId,
            ticketBootMs: reading.elapsedMs,
            deviceWallClockAt: deviceWallClockIso(_deviceNow()),
          );
          await _store.saveTicket(userId, ticket);
          _ticket = ticket;
        }
      }
      await markTooOld();
    } catch (_) {
      // A storage failure leaves the in-memory state as it was; capture re-checks everything.
    }
    _notify();
  }

  /// Saves a punch that could not reach the server. Refused (nothing stored) unless every switch is on, the ticket is
  /// from this boot and under 16 h old, the queue has room, and the device key signs it. The local dependency checks
  /// are UX only (§3.4); the server decides.
  ///
  /// [activeShiftId] is the server's open attendance (if any); [displayAt] is the server-anchored estimate at the tap
  /// (display only; never sent); [location] is the fix taken for this punch, if the venue needs one.
  Future<OfflineCaptureResult> capture({
    required OfflinePunchType type,
    required String shiftId,
    required String idempotencyKey,
    String? activeShiftId,
    String? qrToken,
    LocationFix? location,
    DateTime? displayAt,
  }) async {
    await ready;
    if (unreadable) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.unreadable,
        message: OfflineMessages.unreadable,
      );
    }
    if (!mayQueue) {
      return const OfflineCaptureResult(OfflineCaptureOutcome.notEnabled);
    }
    if (pending.any((e) => e.idempotencyKey == idempotencyKey) ||
        pendingFor(shiftId, type) != null) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.alreadySaved,
        message: OfflineMessages.alreadySaved,
      );
    }
    if (type == OfflinePunchType.clockOut &&
        activeShiftId != shiftId &&
        pendingFor(shiftId, OfflinePunchType.clockIn) == null) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.notClockedIn,
        message: OfflineMessages.notClockedIn,
      );
    }
    final reading = await _bootClock.read();
    final ticket = _ticket;
    if (ticket == null || reading == null || !ticket.canCaptureAt(reading)) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.needsTicket,
        message: OfflineMessages.needsTicket,
      );
    }
    try {
      final seq = await _store.nextClientSeq();
      final fixBootMs = location == null
          ? null
          : (reading.elapsedMs - location.age.inMilliseconds).clamp(
              0,
              reading.elapsedMs,
            );
      final unsigned = OfflineEntry(
        idempotencyKey: idempotencyKey,
        clientSeq: seq,
        type: type,
        shiftId: shiftId,
        ticket: ticket.token,
        bootId: ticket.bootId,
        ticketBootMs: ticket.ticketBootMs,
        punchBootId: reading.bootId,
        punchBootMs: reading.elapsedMs,
        deviceWallClockAt: deviceWallClockIso(_deviceNow()),
        ticketDeviceWallClockAt: ticket.deviceWallClockAt,
        qrToken: qrToken,
        location: location == null
            ? null
            : OfflineLocation(
                lat: location.lat,
                lng: location.lng,
                accuracyM: location.accuracyM,
                fixBootMs: fixBootMs!,
                mock: location.mock,
              ),
        appVersion: kOfflineAppVersion,
        deviceKeyId: _signer.deviceKeyId,
      );
      final sig = await _signer.sign(unsigned.signingPayload());
      if (sig == null || sig.isEmpty) {
        return const OfflineCaptureResult(
          OfflineCaptureOutcome.failed,
          message: OfflineMessages.captureFailed,
        );
      }
      final punch = QueuedPunch(
        entry: unsigned.withSignature(sig),
        displayAt: displayAt ?? _deviceNow(),
      );
      _entries = await _store.append(userId, punch);
      _notify();
      return OfflineCaptureResult(OfflineCaptureOutcome.queued, punch: punch);
    } on OfflineQueueFullException catch (e) {
      final unreadableQueue = e.reason == 'unreadable';
      return OfflineCaptureResult(
        unreadableQueue
            ? OfflineCaptureOutcome.unreadable
            : OfflineCaptureOutcome.full,
        message: unreadableQueue
            ? OfflineMessages.unreadable
            : OfflineMessages.queueFull,
      );
    } catch (_) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.failed,
        message: OfflineMessages.captureFailed,
      );
    }
  }

  /// Marks pending entries older than 72 h (D5) as too old: they are never sent.
  Future<void> markTooOld() async {
    if (!_entries.any((e) => e.isPending)) return;
    final reading = await _bootClock.read();
    final now = _deviceNow();
    bool old(QueuedPunch e) =>
        e.isPending && e.entry.ageAt(reading, now) > OfflineLimits.maxSyncDelay;
    if (!_entries.any(old)) return;
    _entries = await _store.update(
      userId,
      (all) => [
        for (final e in all) old(e) ? e.withState(QueuedPunchState.tooOld) : e,
      ],
    );
  }

  /// Removes one refused / too-old / parked entry after the staff member has seen it. Pending entries cannot be
  /// dismissed one by one (only [discardAll], which the logout guard asks for explicitly).
  Future<void> dismiss(String idempotencyKey) async {
    _entries = await _store.update(
      userId,
      (all) => all
          .where((e) => e.isPending || e.idempotencyKey != idempotencyKey)
          .toList(),
    );
    _notify();
  }

  /// D18: the staff member explicitly discards everything saved on this phone. Discarded = never sent; the manager is
  /// not told. Also clears an unreadable queue and the ticket.
  Future<void> discardAll() async {
    await _store.clear(userId);
    _entries = const [];
    unreadable = false;
    _ticket = null;
    _notify();
  }

  /// Logout once nothing is waiting to send: deletes what is left (refused / too old results, the ticket), so nothing
  /// of this session stays at rest. Returns false (and deletes nothing) while punches are unsent.
  Future<bool> clearForLogout() async {
    await ready;
    if (hasUnsent) return false;
    await discardAll();
    return true;
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
