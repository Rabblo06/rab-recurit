import 'dart:io';

import 'package:flutter/foundation.dart';

/// DESIGN §6.4 / D11: a client-asserted "this phone looks rooted" hint for the offline entry's `integrity.rootedSignal`.
/// A flag on the server's receipt only, NEVER a block: a rooted phone that hooks the app can hide it. A cheap check
/// for the usual `su` binaries on Android (mirrors the iPhone app's file-exists heuristic); every other platform, and
/// any error, answers false. Play Integrity attestation is phase 2.
const List<String> kRootIndicatorPaths = [
  '/system/bin/su',
  '/system/xbin/su',
  '/sbin/su',
  '/system/sd/xbin/su',
  '/system/bin/failsafe/su',
  '/data/local/su',
  '/data/local/xbin/su',
  '/data/local/bin/su',
  '/su/bin/su',
  '/system/app/Superuser.apk',
];

bool rootedSignal({bool Function(String path)? fileExists, bool? isAndroid}) {
  final android =
      isAndroid ?? (!kIsWeb && defaultTargetPlatform == TargetPlatform.android);
  if (!android) return false;
  final exists = fileExists ?? (String p) => File(p).existsSync();
  try {
    return kRootIndicatorPaths.any(exists);
  } catch (_) {
    return false;
  }
}
