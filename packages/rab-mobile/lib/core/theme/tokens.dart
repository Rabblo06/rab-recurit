import 'package:flutter/material.dart';

/// Mirrors `packages/rab-ui/src/tokens/*.ts` — Dart can't import that
/// TypeScript package directly, so these values are kept in sync by hand.
/// If you change a token in `@rab/ui`, change it here too.
class AppColors {
  AppColors._();

  static const bgApp = Color(0xFFF2F3F1);
  static const bgSurface = Color(0xFFFFFFFF);
  static const bgSubtle = Color(0xFFE9EBE8);

  static const accent = Color(0xFF12735A);
  static const accentStrong = Color(0xFF0C5643);
  static const accentSoft = Color(0xFFCFE7DE);

  static const textPrimary = Color(0xFF111312);
  static const textSecondary = Color(0xFF6B7270);
  static const textTertiary = Color(0xFF9AA09E);

  static const border = Color(0xFFE3E6E3);
  static const danger = Color(0xFFB42318);
  static const dangerSoft = Color(0xFFFEF2F2);
  static const warning = Color(0xFFB54708);
  static const info = Color(0xFF175CD3);

  /// One place status -> colour is decided, mirroring `statusColor` in
  /// `@rab/ui`'s `colors.ts`. No widget branches on a status string itself.
  static Color forStatus(String status) {
    switch (status) {
      case 'pending':
      case 'open':
      case 'offered':
        return info;
      case 'staff_accepted':
      case 'partially_filled':
        return warning;
      case 'manager_confirmed':
      case 'fully_filled':
      case 'confirmed':
      case 'in_progress':
      case 'completed':
        return accent;
      case 'manager_rejected':
      case 'declined':
      case 'cancelled':
        return danger;
      default:
        return textSecondary;
    }
  }
}

class AppSpace {
  AppSpace._();
  static const s1 = 2.0;
  static const s2 = 4.0;
  static const s3 = 8.0;
  static const s4 = 12.0;
  static const s5 = 16.0;
  static const s6 = 20.0;
  static const s7 = 24.0;
  static const s8 = 32.0;
  static const s9 = 48.0;
  static const s10 = 64.0;
}

class AppRadius {
  AppRadius._();
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 24.0;
  static const full = 999.0;
}

class AppText {
  AppText._();

  static const screenTitle = TextStyle(
    fontSize: 30,
    height: 36 / 30,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.02 * 30,
    color: AppColors.textPrimary,
  );
  static const pageTitle = TextStyle(
    fontSize: 24,
    height: 30 / 24,
    fontWeight: FontWeight.w600,
    letterSpacing: -0.015 * 24,
    color: AppColors.textPrimary,
  );
  static const section = TextStyle(
    fontSize: 18,
    height: 24 / 18,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimary,
  );
  static const bodyMobile = TextStyle(
    fontSize: 15,
    height: 22 / 15,
    fontWeight: FontWeight.w400,
    color: AppColors.textPrimary,
  );
  static const label = TextStyle(
    fontSize: 13,
    height: 18 / 13,
    fontWeight: FontWeight.w400,
    color: AppColors.textSecondary,
  );
  static const metricMobile = TextStyle(
    fontSize: 28,
    height: 34 / 28,
    fontWeight: FontWeight.w700,
    fontFeatures: [FontFeature.tabularFigures()],
    color: AppColors.textPrimary,
  );
}

ThemeData buildAppTheme() {
  return ThemeData(
    useMaterial3: true,
    scaffoldBackgroundColor: AppColors.bgApp,
    colorScheme: ColorScheme.fromSeed(
      seedColor: AppColors.accent,
      primary: AppColors.accent,
      surface: AppColors.bgSurface,
      error: AppColors.danger,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.bgApp,
      foregroundColor: AppColors.textPrimary,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
    ),
    textSelectionTheme: const TextSelectionThemeData(cursorColor: AppColors.accent),
  );
}
