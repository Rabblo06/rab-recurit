import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// Shared "nothing here yet" treatment for genuine empty-result states,
/// defined once rather than duplicated per screen.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, required this.message});

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpace.s9),
      child: Column(
        children: [
          Icon(icon, size: 40, color: context.colors.textTertiary),
          const SizedBox(height: AppSpace.s4),
          Text(title, style: context.text.section, textAlign: TextAlign.center),
          const SizedBox(height: AppSpace.s2),
          Text(
            message,
            style: context.text.bodyMobile.copyWith(color: context.colors.textSecondary),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}
