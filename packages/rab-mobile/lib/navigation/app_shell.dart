import 'package:flutter/material.dart';
import '../core/theme/schedule_tokens.dart';

import '../core/theme/tokens.dart';
import '../core/motion/shift_motion.dart';
import 'moving_tab_bar.dart';
import '../features/calendar/calendar_screen.dart';
import '../features/history/history_screen.dart';
import '../features/home/schedule_home_screen.dart';
import '../features/profile/profile_screen.dart';

/// Bottom-tab shell: Home / Calendar / History / Profile. Offers and
/// Notifications aren't tabs — Offers is reached by tapping a stat card on
/// Home, Notifications by the "Inbox" row on Profile (or the bell icon on
/// Home).
class AppShell extends StatefulWidget {
  const AppShell({super.key, this.readOnly = false});
  final bool readOnly;

  static AppShellState? of(BuildContext context) =>
      context.findAncestorStateOfType<AppShellState>();

  @override
  State<AppShell> createState() => AppShellState();
}

class AppShellState extends State<AppShell>
    with SingleTickerProviderStateMixin {
  int _index = 0;
  late final AnimationController _tabTransition = AnimationController(
    vsync: this,
    duration: AppMotion.tabTransition,
    value: 1,
  );

  void goToTab(int index) {
    if (index == _index) return;
    setState(() => _index = index);
    if (ShiftMotion.reduced(context)) {
      _tabTransition.value = 1;
    } else {
      _tabTransition.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _tabTransition.dispose();
    super.dispose();
  }

  static const _screens = [
    ScheduleHomeScreen(),
    CalendarScreen(),
    HistoryScreen(),
    ProfileScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    final curved = CurvedAnimation(
      parent: _tabTransition,
      curve: AppMotion.curve,
    );

    return Scaffold(
      backgroundColor: _index == 0
          ? ScheduleTokens.homeBackground
          : ScheduleTokens.background,
      extendBody: _index == 0,
      // A short crossfade + small directional shift (§46) applied on top of
      // the same persistent `IndexedStack` — deliberately NOT an
      // `AnimatedSwitcher`/keyed-child swap, which would dispose and
      // recreate each tab's screen (losing scroll position and re-firing
      // `initState` data loads) every time the user switches away and back.
      body: FadeTransition(
        opacity: curved,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, 0.015),
            end: Offset.zero,
          ).animate(curved),
          child: IndexedStack(
            index: _index,
            children: [
              for (var i = 0; i < _screens.length; i++)
                TickerMode(
                  enabled: i == _index,
                  child: widget.readOnly && i != 3
                      ? const SafeArea(
                          child: Center(
                            child: Padding(
                              padding: EdgeInsets.all(24),
                              child: Text(
                                'Staff app\n\nYou are signed in as Internal Manager. Personal shifts, payslips and clocking require a Staff profile and are unavailable for this account.',
                              ),
                            ),
                          ),
                        )
                      : _screens[i],
                ),
            ],
          ),
        ),
      ),
      bottomNavigationBar: MovingTabBar(index: _index, onSelected: goToTab),
    );
  }
}
