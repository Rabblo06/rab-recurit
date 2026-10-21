import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app.dart';
import 'core/auth/auth_provider.dart';
import 'core/theme/shift_colour_store.dart';
import 'core/theme/shift_visual_style.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Restore shift colours before the first card is built.
  await ShiftColourStore.attach(ShiftVisualStyle.registry);
  runApp(
    ChangeNotifierProvider(
      create: (_) => AuthProvider(),
      child: const RabApp(),
    ),
  );
}
