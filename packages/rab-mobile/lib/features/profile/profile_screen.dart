import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/theme/tokens.dart';
import '../notifications/notifications_provider.dart';
import '../notifications/notifications_screen.dart';
import 'security_screen.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final auth = context.watch<AuthProvider>();
    final user = auth.user;
    final fullName = user?.fullName ?? '';
    final unread = context.watch<NotificationsProvider>().unreadCount;

    return Scaffold(
      backgroundColor: colors.bgApp,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpace.s5),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Profile', style: text.pageTitle),
              const SizedBox(height: AppSpace.s5),
              Container(
                padding: const EdgeInsets.all(AppSpace.s5),
                decoration: BoxDecoration(
                  color: colors.bgSurface,
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  border: Border.all(color: colors.border),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(color: colors.accentSoft, shape: BoxShape.circle),
                      alignment: Alignment.center,
                      child: Text(
                        fullName.isNotEmpty ? fullName[0] : '·',
                        style: text.section.copyWith(color: colors.accentStrong),
                      ),
                    ),
                    const SizedBox(width: AppSpace.s4),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(fullName.isNotEmpty ? fullName : 'Loading…', style: text.section),
                          const SizedBox(height: AppSpace.s1),
                          Text(user?.email ?? '', style: text.label),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpace.s5),
              Container(
                decoration: BoxDecoration(
                  color: colors.bgSurface,
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  border: Border.all(color: colors.border),
                ),
                child: ListTile(
                  leading: Icon(Icons.inbox_outlined, color: colors.textPrimary),
                  title: Text('Inbox', style: text.bodyMobile),
                  trailing: unread > 0
                      ? Badge(label: Text('$unread'))
                      : Icon(Icons.chevron_right, color: colors.textTertiary),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsScreen())),
                ),
              ),
              const SizedBox(height: AppSpace.s3),
              Container(
                decoration: BoxDecoration(
                  color: colors.bgSurface,
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  border: Border.all(color: colors.border),
                ),
                child: ListTile(
                  leading: Icon(Icons.shield_outlined, color: colors.textPrimary),
                  title: Text('Security', style: text.bodyMobile),
                  trailing: Icon(Icons.chevron_right, color: colors.textTertiary),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SecurityScreen())),
                ),
              ),
              const SizedBox(height: AppSpace.s6),
              SizedBox(
                height: 48,
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    side: BorderSide(color: colors.danger),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
                  ),
                  onPressed: auth.logout,
                  child: Text('Log out', style: text.bodyMobile.copyWith(color: colors.danger, fontWeight: FontWeight.w600)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
