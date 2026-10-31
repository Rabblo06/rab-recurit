import 'package:flutter/material.dart';

import '../theme/schedule_tokens.dart';

/// The polling policy's non-blocking "couldn't refresh" state: shown above data that is still on screen after a
/// refresh failed, instead of an error page that would hide it. The data below stays the last good server answer.
class StaleRefreshNotice extends StatelessWidget {
  const StaleRefreshNotice({
    super.key = const ValueKey('stale-refresh-notice'),
    this.message = "Couldn't refresh. Showing the last update.",
  });
  final String message;

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          const Icon(Icons.cloud_off, size: 16, color: ScheduleTokens.muted),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(fontSize: 12, color: ScheduleTokens.muted),
            ),
          ),
        ],
      ),
    ),
  );
}
