import 'package:flutter/material.dart';

import '../../core/theme/tokens.dart';
import '../../core/widgets/empty_state.dart';

/// Skeleton for this increment — real completed-shift/attendance data is
/// wired up in Increment 7, once a real attendance backend exists.
class HistoryScreen extends StatelessWidget {
  const HistoryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.colors.bgApp,
      appBar: AppBar(title: const Text('History')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpace.s5),
          children: const [
            EmptyState(
              icon: Icons.history,
              title: 'No history yet',
              message: 'Completed shifts will show up here.',
            ),
          ],
        ),
      ),
    );
  }
}
