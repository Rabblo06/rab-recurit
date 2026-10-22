import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app.dart';
import 'core/auth/auth_provider.dart';
import 'core/storage/secure_storage_bootstrap.dart';
import 'core/theme/shift_colour_store.dart';
import 'core/theme/shift_visual_style.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // F2: before ANY secure-storage read (AuthProvider reads tokens on
  // construction). Wipes a previous install's Keychain items and re-writes
  // pre-F2 iOS items with device-only accessibility.
  try {
    await SecureStorageBootstrap().run();
  } catch (error) {
    // Secure storage unavailable (e.g. iOS before first unlock). The marker
    // and sentinel are written only after the wipe/migration succeed and every
    // step is idempotent, so the whole check reruns next launch; reads in this
    // session hit the same unavailable storage and so find no session.
    debugPrint('Secure storage bootstrap failed: $error');
  }
  // Restore shift colours before the first card is built.
  await ShiftColourStore.attach(ShiftVisualStyle.registry);
  runApp(
    ChangeNotifierProvider(
      create: (_) => AuthProvider(),
      child: const RabApp(),
    ),
  );
}
