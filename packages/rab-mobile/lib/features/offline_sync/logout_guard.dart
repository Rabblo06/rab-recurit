import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'offline_messages.dart';
import 'offline_sync_controller.dart';

enum _GuardChoice { stay, send, discard }

/// D18: logout is blocked while punches saved on this phone have not been sent, until they sync or the staff member
/// explicitly discards them. Discarded = never sent; the manager is not told.
///
/// With nothing waiting, whatever is left (refused or too-old results, the ticket) is deleted before [logout], so
/// nothing of this session stays at rest. Without an offline controller (every presentation but staff) this is just
/// [logout].
Future<void> logoutWithOfflineGuard(
  BuildContext context,
  Future<void> Function() logout,
) async {
  final offline = context.read<OfflineSyncController?>();
  if (offline == null) return logout();
  await offline.ready;
  if (await offline.clearForLogout()) return logout();
  if (!context.mounted) return;
  final count = offline.pendingCount;
  final choice = await showDialog<_GuardChoice>(
    context: context,
    builder: (dialog) => AlertDialog(
      key: const ValueKey('offline-logout-guard'),
      title: const Text('Actions not sent yet'),
      content: Text(
        count == 0
            // The stored queue could not be read (security review L3): never cleared silently.
            ? 'Actions saved on this phone could not be read right now, so they may not have been sent. '
                  'Try again later, or tell your manager.\n\n'
                  'If you log out now anything saved on this phone will be discarded and never sent, and your '
                  'manager will not be told.'
            : '${count == 1 ? '1 action is' : '$count actions are'} saved on this phone and '
                  'not sent yet. Connect to the internet to send them before you log out.\n\n'
                  'If you log out now they will be discarded and never sent, and your manager will not be told.',
      ),
      actions: [
        TextButton(
          key: const ValueKey('offline-logout-stay'),
          onPressed: () => Navigator.pop(dialog, _GuardChoice.stay),
          child: const Text('Stay signed in'),
        ),
        TextButton(
          key: const ValueKey('offline-logout-send'),
          onPressed: () => Navigator.pop(dialog, _GuardChoice.send),
          child: const Text('Send now'),
        ),
        TextButton(
          key: const ValueKey('offline-logout-discard'),
          onPressed: () => Navigator.pop(dialog, _GuardChoice.discard),
          child: const Text('Discard and log out'),
        ),
      ],
    ),
  );
  switch (choice) {
    case _GuardChoice.discard:
      await discardThenLogout(offline, logout);
    case _GuardChoice.send:
      await offline.syncNow(userInitiated: true);
      if (await offline.clearForLogout()) {
        await logout();
      } else if (context.mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(content: Text(OfflineMessages.stillNotSent)),
        );
      }
    case _GuardChoice.stay || null:
      return;
  }
}

/// The staff member chose to discard. A broken store must never trap them signed in (re-review Low): if the discard
/// itself fails, logout still runs. Whatever could not be deleted stays keyed to this user (never readable by another
/// account) and shows again if they sign back in.
Future<void> discardThenLogout(
  OfflineSyncController offline,
  Future<void> Function() logout,
) async {
  try {
    await offline.discardAll();
  } catch (error) {
    debugPrint('Offline queue discard failed, logging out anyway: $error');
  }
  await logout();
}
