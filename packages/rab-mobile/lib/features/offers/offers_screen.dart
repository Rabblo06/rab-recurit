import 'package:flutter/material.dart';

import 'schedule_offers_screen.dart';

/// Schedule is the only UI style — this simply hands off to it. Kept as a
/// distinct class (rather than replacing every call site with
/// `ScheduleOffersScreen` directly) since "Offers" is a stable navigation
/// target other screens push to by name.
class OffersScreen extends StatelessWidget {
  const OffersScreen({super.key});

  @override
  Widget build(BuildContext context) => const ScheduleOffersScreen();
}
