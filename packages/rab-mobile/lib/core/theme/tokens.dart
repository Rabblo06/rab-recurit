import 'package:flutter/material.dart';

/// Design tokens as a `ThemeExtension` pair, resolved per-`BuildContext` via
/// `context.colors`/`context.text` — this is what lets every screen share
/// one body of layout code across light and dark instead of duplicating
/// widgets per theme (see `buildLightTheme`/`buildDarkTheme`). Mirrors
/// `packages/rab-ui/src/tokens/*.ts` (light-only there too, as of writing —
/// if that package ever adds dark tokens, mirror those values back here
/// rather than the other way round, since this file defined dark mode first).
@immutable
class AppColorsX extends ThemeExtension<AppColorsX> {
  const AppColorsX({
    required this.bgApp,
    required this.bgSurface,
    required this.bgSubtle,
    required this.accent,
    required this.accentStrong,
    required this.accentSoft,
    required this.textPrimary,
    required this.textSecondary,
    required this.textTertiary,
    required this.border,
    required this.danger,
    required this.dangerSoft,
    required this.warning,
    required this.info,
    required this.gold,
  });

  final Color bgApp;
  final Color bgSurface;
  final Color bgSubtle;
  final Color accent;
  final Color accentStrong;
  final Color accentSoft;
  final Color textPrimary;
  final Color textSecondary;
  final Color textTertiary;
  final Color border;
  final Color danger;
  final Color dangerSoft;
  final Color warning;
  final Color info;
  final Color gold;

  static const light = AppColorsX(
    bgApp: Color(0xFFF2F3F1),
    bgSurface: Color(0xFFFFFFFF),
    bgSubtle: Color(0xFFE9EBE8),
    accent: Color(0xFF12735A),
    accentStrong: Color(0xFF0C5643),
    accentSoft: Color(0xFFCFE7DE),
    textPrimary: Color(0xFF111312),
    textSecondary: Color(0xFF6B7270),
    textTertiary: Color(0xFF9AA09E),
    border: Color(0xFFE3E6E3),
    danger: Color(0xFFB42318),
    dangerSoft: Color(0xFFFEF2F2),
    warning: Color(0xFFB54708),
    info: Color(0xFF175CD3),
    gold: Color(0xFFC9A227),
  );

  static const dark = AppColorsX(
    bgApp: Color(0xFF0B0D0C),
    bgSurface: Color(0xE6161A18),
    bgSubtle: Color(0xFF1E2321),
    accent: Color(0xFF1DBF97),
    accentStrong: Color(0xFF14876C),
    accentSoft: Color(0xFFB9E9DA),
    textPrimary: Color(0xFFF5F6F5),
    textSecondary: Color(0xFF9BA29E),
    textTertiary: Color(0xFF6B7270),
    border: Color(0xFF262B29),
    danger: Color(0xFFF04438),
    dangerSoft: Color(0xFF3A1616),
    warning: Color(0xFFF79009),
    info: Color(0xFF53B1FD),
    gold: Color(0xFFE8B84B),
  );

  /// One place status -> colour is decided, mirroring `statusColor` in
  /// `@rab/ui`'s `colors.ts`. No widget branches on a status string itself.
  Color forStatus(String status) {
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

  @override
  AppColorsX copyWith({
    Color? bgApp,
    Color? bgSurface,
    Color? bgSubtle,
    Color? accent,
    Color? accentStrong,
    Color? accentSoft,
    Color? textPrimary,
    Color? textSecondary,
    Color? textTertiary,
    Color? border,
    Color? danger,
    Color? dangerSoft,
    Color? warning,
    Color? info,
    Color? gold,
  }) {
    return AppColorsX(
      bgApp: bgApp ?? this.bgApp,
      bgSurface: bgSurface ?? this.bgSurface,
      bgSubtle: bgSubtle ?? this.bgSubtle,
      accent: accent ?? this.accent,
      accentStrong: accentStrong ?? this.accentStrong,
      accentSoft: accentSoft ?? this.accentSoft,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textTertiary: textTertiary ?? this.textTertiary,
      border: border ?? this.border,
      danger: danger ?? this.danger,
      dangerSoft: dangerSoft ?? this.dangerSoft,
      warning: warning ?? this.warning,
      info: info ?? this.info,
      gold: gold ?? this.gold,
    );
  }

  @override
  AppColorsX lerp(ThemeExtension<AppColorsX>? other, double t) {
    if (other is! AppColorsX) return this;
    return AppColorsX(
      bgApp: Color.lerp(bgApp, other.bgApp, t)!,
      bgSurface: Color.lerp(bgSurface, other.bgSurface, t)!,
      bgSubtle: Color.lerp(bgSubtle, other.bgSubtle, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      accentStrong: Color.lerp(accentStrong, other.accentStrong, t)!,
      accentSoft: Color.lerp(accentSoft, other.accentSoft, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      textTertiary: Color.lerp(textTertiary, other.textTertiary, t)!,
      border: Color.lerp(border, other.border, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
      dangerSoft: Color.lerp(dangerSoft, other.dangerSoft, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      info: Color.lerp(info, other.info, t)!,
      gold: Color.lerp(gold, other.gold, t)!,
    );
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

@immutable
class AppTextX extends ThemeExtension<AppTextX> {
  const AppTextX({
    required this.screenTitle,
    required this.pageTitle,
    required this.section,
    required this.bodyMobile,
    required this.label,
    required this.metricMobile,
  });

  final TextStyle screenTitle;
  final TextStyle pageTitle;
  final TextStyle section;
  final TextStyle bodyMobile;
  final TextStyle label;
  final TextStyle metricMobile;

  factory AppTextX.forColors(AppColorsX c) {
    return AppTextX(
      screenTitle: TextStyle(
        fontSize: 30,
        height: 36 / 30,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.02 * 30,
        color: c.textPrimary,
      ),
      pageTitle: TextStyle(
        fontSize: 24,
        height: 30 / 24,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.015 * 24,
        color: c.textPrimary,
      ),
      section: TextStyle(
        fontSize: 18,
        height: 24 / 18,
        fontWeight: FontWeight.w600,
        color: c.textPrimary,
      ),
      bodyMobile: TextStyle(
        fontSize: 15,
        height: 22 / 15,
        fontWeight: FontWeight.w400,
        color: c.textPrimary,
      ),
      label: TextStyle(
        fontSize: 13,
        height: 18 / 13,
        fontWeight: FontWeight.w400,
        color: c.textSecondary,
      ),
      metricMobile: TextStyle(
        fontSize: 28,
        height: 34 / 28,
        fontWeight: FontWeight.w700,
        fontFeatures: const [FontFeature.tabularFigures()],
        color: c.textPrimary,
      ),
    );
  }

  @override
  AppTextX copyWith({
    TextStyle? screenTitle,
    TextStyle? pageTitle,
    TextStyle? section,
    TextStyle? bodyMobile,
    TextStyle? label,
    TextStyle? metricMobile,
  }) {
    return AppTextX(
      screenTitle: screenTitle ?? this.screenTitle,
      pageTitle: pageTitle ?? this.pageTitle,
      section: section ?? this.section,
      bodyMobile: bodyMobile ?? this.bodyMobile,
      label: label ?? this.label,
      metricMobile: metricMobile ?? this.metricMobile,
    );
  }

  @override
  AppTextX lerp(ThemeExtension<AppTextX>? other, double t) {
    if (other is! AppTextX) return this;
    return AppTextX(
      screenTitle: TextStyle.lerp(screenTitle, other.screenTitle, t)!,
      pageTitle: TextStyle.lerp(pageTitle, other.pageTitle, t)!,
      section: TextStyle.lerp(section, other.section, t)!,
      bodyMobile: TextStyle.lerp(bodyMobile, other.bodyMobile, t)!,
      label: TextStyle.lerp(label, other.label, t)!,
      metricMobile: TextStyle.lerp(metricMobile, other.metricMobile, t)!,
    );
  }
}

/// `context.colors`/`context.text` — the call-site API every screen uses
/// instead of the old `AppColors.x`/`AppText.x` static constants.
extension AppThemeContext on BuildContext {
  AppColorsX get colors => Theme.of(this).extension<AppColorsX>()!;
  AppTextX get text => Theme.of(this).extension<AppTextX>()!;
}

ThemeData buildLightTheme() => _buildTheme(AppColorsX.light, Brightness.light);

ThemeData buildDarkTheme() => _buildTheme(AppColorsX.dark, Brightness.dark);

ThemeData _buildTheme(AppColorsX colors, Brightness brightness) {
  final text = AppTextX.forColors(colors);
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    scaffoldBackgroundColor: colors.bgApp,
    colorScheme: ColorScheme.fromSeed(
      seedColor: colors.accent,
      brightness: brightness,
      primary: colors.accent,
      surface: colors.bgSurface,
      error: colors.danger,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: colors.bgApp,
      foregroundColor: colors.textPrimary,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
    ),
    textSelectionTheme: TextSelectionThemeData(cursorColor: colors.accent),
    extensions: [colors, text],
  );
}
