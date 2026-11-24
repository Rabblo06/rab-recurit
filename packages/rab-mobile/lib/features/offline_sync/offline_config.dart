/// M4 offline clock-in (docs/plans/m4-offline/DESIGN.md, owner-approved 2026-11-21).
///
/// HARD RULE (owner, 2026-11-21): offline mode stays OFF everywhere until M5 payroll adjustments exist and
/// `POST /attendance/me/sync` has been pen-tested (ROLLOUT-CHECKLIST.md). This app therefore queues a punch only when
/// ALL of these hold, and every one of them is off today:
///
/// 1. this build was compiled with `--dart-define=OFFLINE_ATTENDANCE=true` ([kOfflineAttendanceBuildFlag], default
///    false, so every existing build and every build made without the define can never queue);
/// 2. the server said so in the last `GET /attendance/me/active` (`offline.enabled == true`, exactly `true`; anything
///    else, including an older server that sends nothing, is off). The server only says so when its env kill switch
///    and the venue's `offline_attendance_enabled` are both on, which no code path does before the checklist;
/// 3. the phone holds a server-signed offline ticket from this boot session, received less than
///    [OfflineLimits.maxCaptureAge] ago (DESIGN §3.4, §4.2);
/// 4. a registered, hardware-backed device key can sign the entry (DESIGN §6). The key and its registration route do
///    not exist yet, so the signer is a placeholder that is never available (`entry_signer.dart`).
library;

/// Build-time switch (1). Default false. Turning it on is part of ROLLOUT-CHECKLIST.md section B, never a default.
const bool kOfflineAttendanceBuildFlag = bool.fromEnvironment(
  'OFFLINE_ATTENDANCE',
  defaultValue: false,
);

/// The owner-approved limits (DESIGN §3.4, §3.5, D5). The server enforces its own copies
/// (`OFFLINE_MAX_CAPTURE_AGE_HOURS`, `OFFLINE_SYNC_MAX_DELAY_HOURS`, `OFFLINE_SYNC_MAX_BATCH`); these are the phone's
/// UX limits and may only be equal or stricter.
abstract final class OfflineLimits {
  /// At most 30 entries per user on this phone.
  static const int maxEntries = 30;

  /// At most 48 KB (the stored JSON, UTF-8) per user.
  static const int maxBytes = 48 * 1024;

  /// D5: an entry older than this is never sent ("Too old to send automatically").
  static const Duration maxSyncDelay = Duration(hours: 72);

  /// D5: no entry may be captured more than this after the ticket was received.
  static const Duration maxCaptureAge = Duration(hours: 16);

  /// At most 25 entries per `POST /attendance/me/sync` request.
  static const int maxBatch = 25;

  /// DESIGN §4.2: a ticket whose fetch took longer than this is thrown away, so the receipt-to-issue gap stays small.
  static const Duration maxTicketFetch = Duration(seconds: 10);

  /// DESIGN §3.5: a 5xx or network failure backs off exponentially between these.
  static const Duration minBackoff = Duration(seconds: 1);
  static const Duration maxBackoff = Duration(minutes: 5);

  /// A server `Retry-After` longer than this is capped (a bad or hostile value must not park the queue for days).
  static const Duration maxRetryAfter = Duration(minutes: 15);
}

/// Diagnostics only (`appVersion` in an entry). Never used for any decision.
const String kOfflineAppVersion = String.fromEnvironment(
  'APP_VERSION',
  defaultValue: 'rab-mobile 1.0.0+1',
);
