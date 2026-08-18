import 'package:flutter/material.dart';

import '../core/theme/tokens.dart';
import '../features/home/home_screen.dart';
import '../features/offers/offers_screen.dart';
import '../features/profile/profile_screen.dart';

/// Bottom-tab shell for the three real, data-backed sections. Deliberately
/// no Calendar/History tabs — those need attendance/payroll data that
/// doesn't exist in the backend yet (later phase); adding them here would
/// mean either faking numbers or shipping a dead tab, neither of which is
/// acceptable (see CLAUDE.md: no seeded dashboard numbers).
class AppShell extends StatefulWidget {
  const AppShell({super.key});

  static AppShellState? of(BuildContext context) => context.findAncestorStateOfType<AppShellState>();

  @override
  State<AppShell> createState() => AppShellState();
}

class AppShellState extends State<AppShell> {
  int _index = 0;

  void goToTab(int index) => setState(() => _index = index);

  static const _screens = [HomeScreen(), OffersScreen(), ProfileScreen()];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(index: _index, children: _screens),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: goToTab,
        backgroundColor: AppColors.bgSurface,
        indicatorColor: AppColors.accentSoft,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.work_outline), selectedIcon: Icon(Icons.work), label: 'Offers'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
