import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/theme/tokens.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final user = auth.user;
    final fullName = user?.fullName ?? '';

    return Scaffold(
      backgroundColor: AppColors.bgApp,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpace.s5),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Profile', style: AppText.pageTitle),
              const SizedBox(height: AppSpace.s5),
              Container(
                padding: const EdgeInsets.all(AppSpace.s5),
                decoration: BoxDecoration(
                  color: AppColors.bgSurface,
                  borderRadius: BorderRadius.circular(AppRadius.md),
                  border: Border.all(color: AppColors.border),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 48,
                      height: 48,
                      decoration: const BoxDecoration(color: AppColors.accentSoft, shape: BoxShape.circle),
                      alignment: Alignment.center,
                      child: Text(
                        fullName.isNotEmpty ? fullName[0] : '·',
                        style: AppText.section.copyWith(color: AppColors.accentStrong),
                      ),
                    ),
                    const SizedBox(width: AppSpace.s4),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(fullName.isNotEmpty ? fullName : 'Loading…', style: AppText.section),
                          const SizedBox(height: AppSpace.s1),
                          Text(user?.email ?? '', style: AppText.label),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpace.s6),
              SizedBox(
                height: 48,
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    side: const BorderSide(color: AppColors.danger),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
                  ),
                  onPressed: auth.logout,
                  child: Text('Log out', style: AppText.bodyMobile.copyWith(color: AppColors.danger, fontWeight: FontWeight.w600)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
