import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/models/current_user.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_nav_header.dart';
import '../../navigation/app_shell.dart';
import '../notifications/notifications_provider.dart';
import '../notifications/notifications_screen.dart';
import '../payslips/payslips_screen.dart';
import 'security_screen.dart';

/// Only entries with a real destination are listed. Availability editing and
/// help/support have no staff-app screen yet, so they are not shown here.
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final user = auth.user;
    final fullName = user?.fullName.trim() ?? '';
    final unread = context.watch<NotificationsProvider>().unreadCount;
    final first = user?.firstName.trim() ?? '';
    final last = user?.lastName.trim() ?? '';
    final initials =
        '${first.isEmpty ? '' : first.characters.first}${last.isEmpty ? '' : last.characters.first}'
            .toUpperCase();
    final account = switch (user?.presentation) {
      AppPresentation.staff => 'Staff account',
      AppPresentation.venueManager => 'Venue manager account',
      AppPresentation.manager => 'Manager account',
      _ => null,
    };
    void push(Widget page) => Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => page));

    return Scaffold(
      backgroundColor: ScheduleTokens.background,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
              child: ScheduleNavHeader(
                title: 'Profile',
                onBack: () => AppShell.of(context)?.goToTab(0),
              ),
            ),
            Expanded(
              child: ListView(
                padding: EdgeInsets.fromLTRB(
                  20,
                  8,
                  20,
                  MediaQuery.viewPaddingOf(context).bottom + 110,
                ),
                children: [
                  _Group(
                    children: [
                      Padding(
                        padding: const EdgeInsets.all(18),
                        child: Row(
                          children: [
                            Container(
                              width: 64,
                              height: 64,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: ScheduleTokens.mint,
                                borderRadius: BorderRadius.circular(18),
                                border: Border.all(
                                  color: const Color(0xFFCDEBDD),
                                ),
                              ),
                              child: Text(
                                initials.isEmpty ? '·' : initials,
                                style: ScheduleType.cardTitle.copyWith(
                                  fontSize: 22,
                                  color: const Color(0xFF0B6B47),
                                ),
                              ),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    fullName.isNotEmpty ? fullName : 'Loading…',
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: ScheduleType.cardTitle.copyWith(
                                      fontSize: 20,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    user?.email ?? '',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: ScheduleType.secondary,
                                  ),
                                  if (account != null) ...[
                                    const SizedBox(height: 2),
                                    Text(
                                      account,
                                      style: ScheduleType.caption.copyWith(
                                        color: ScheduleTokens.successText,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const _SectionLabel('WORK'),
                  _Group(
                    children: [
                      _Row(
                        icon: Icons.receipt_long_outlined,
                        label: 'Payslips',
                        onTap: () => push(const PayslipsScreen()),
                      ),
                    ],
                  ),
                  const _SectionLabel('ACCOUNT'),
                  _Group(
                    children: [
                      _Row(
                        icon: Icons.mail_outline,
                        label: 'Inbox',
                        trailing: unread > 0
                            ? Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 3,
                                ),
                                decoration: BoxDecoration(
                                  color: ScheduleTokens.dangerSoft,
                                  borderRadius: BorderRadius.circular(999),
                                ),
                                child: Text(
                                  '$unread',
                                  semanticsLabel: '$unread unread',
                                  style: ScheduleType.badge.copyWith(
                                    color: ScheduleTokens.errorText,
                                  ),
                                ),
                              )
                            : null,
                        onTap: () => push(const NotificationsScreen()),
                      ),
                      _Row(
                        icon: Icons.shield_outlined,
                        label: 'Security',
                        onTap: () => push(const SecurityScreen()),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  SizedBox(
                    height: ScheduleTokens.actionHeight,
                    child: FilledButton(
                      style: FilledButton.styleFrom(
                        backgroundColor: ScheduleTokens.dangerSoft,
                        foregroundColor: ScheduleTokens.errorText,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                        ),
                        textStyle: ScheduleType.button.copyWith(
                          fontFamily: Theme.of(
                            context,
                          ).textTheme.labelLarge?.fontFamily,
                        ),
                      ),
                      onPressed: auth.logout,
                      child: const Text('Log out'),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 24, 4, 10),
    child: Text(text, style: ScheduleType.overline),
  );
}

class _Group extends StatelessWidget {
  const _Group({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: ScheduleTokens.border),
    ),
    clipBehavior: Clip.antiAlias,
    child: Column(
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0)
            const Divider(height: 1, indent: 56, color: ScheduleTokens.border),
          children[i],
        ],
      ],
    ),
  );
}

class _Row extends StatelessWidget {
  const _Row({
    required this.icon,
    required this.label,
    required this.onTap,
    this.trailing,
  });
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    child: ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 60),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
        child: Row(
          children: [
            Icon(icon, size: 22, color: ScheduleTokens.ink),
            const SizedBox(width: 16),
            Expanded(child: Text(label, style: ScheduleType.body)),
            ?trailing,
            const SizedBox(width: 6),
            const Icon(Icons.chevron_right, color: ScheduleTokens.muted),
          ],
        ),
      ),
    ),
  );
}
