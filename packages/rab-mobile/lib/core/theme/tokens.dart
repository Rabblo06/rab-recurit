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
    required this.authBg,
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
    required this.authShellDark,
    required this.atmosphereDeep,
    required this.atmosphereMid,
    required this.onDarkPrimary,
    required this.onDarkSecondary,
    required this.ringProgress,
  });

  final Color bgApp;

  /// Warm off-white background used only by the auth-flow screens (Welcome,
  /// Login, biometric lock/setup, password reset) — every other screen keeps
  /// `bgApp`. Kept separate from `authShellDark` below: `authBg` is the base
  /// under the atmospheric geometry, `authShellDark` is the persistent black
  /// upper region that Welcome's small object morphs into on Login onward.
  final Color authBg;
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

  /// The persistent near-black upper region of the auth flow (Login, Set
  /// Password, Biometric Setup/Unlock) — see `AuthFlowShell`.
  final Color authShellDark;

  /// Deep forest green — the atmospheric backdrop's base tone (Welcome
  /// geometry, Clock In/Out hero background).
  final Color atmosphereDeep;

  /// Muted sage — the atmospheric backdrop's lighter tonal variation.
  final Color atmosphereMid;
  final Color onDarkPrimary;
  final Color onDarkSecondary;

  /// Light desaturated sage used for the Clock In/Out progress ring's
  /// completed arc, against `atmosphereDeep`.
  final Color ringProgress;

  static const light = AppColorsX(
    bgApp: Color(0xFFF2F4F2),
    authBg: Color(0xFFFAF8F3),
    bgSurface: Color(0xFFFFFFFF),
    bgSubtle: Color(0xFFE9EBE8),
    accent: Color(0xFF0F6E56),
    accentStrong: Color(0xFF0B5240),
    accentSoft: Color(0xFFD9EFE6),
    textPrimary: Color(0xFF1A1A18),
    textSecondary: Color(0xFF77746C),
    textTertiary: Color(0xFF9AA09E),
    border: Color(0xFFE5E0D5),
    danger: Color(0xFF8C3A32),
    dangerSoft: Color(0xFFFBEEEC),
    warning: Color(0xFFB54708),
    info: Color(0xFF175CD3),
    gold: Color(0xFFB08A4E),
    authShellDark: Color(0xFF14140F),
    atmosphereDeep: Color(0xFF1F3D2E),
    atmosphereMid: Color(0xFF3E6350),
    onDarkPrimary: Color(0xFFF7F6F1),
    onDarkSecondary: Color(0xB3F7F6F1),
    ringProgress: Color(0xFFAFCBB9),
  );

  static const dark = AppColorsX(
    bgApp: Color(0xFF0B0D0C),
    authBg: Color(0xFF14140F),
    bgSurface: Color(0xE6161A18),
    bgSubtle: Color(0xFF1E2321),
    accent: Color(0xFF1AC79E),
    accentStrong: Color(0xFF13946F),
    accentSoft: Color(0xFFB9E9DA),
    textPrimary: Color(0xFFF5F6F5),
    textSecondary: Color(0xFFA39E92),
    textTertiary: Color(0xFF6B7270),
    border: Color(0xFF2B2820),
    danger: Color(0xFFD4776C),
    dangerSoft: Color(0xFF3A1616),
    warning: Color(0xFFF79009),
    info: Color(0xFF53B1FD),
    gold: Color(0xFFC7A46A),
    authShellDark: Color(0xFF0C0C09),
    atmosphereDeep: Color(0xFF16281F),
    atmosphereMid: Color(0xFF2E4B3B),
    onDarkPrimary: Color(0xFFF7F6F1),
    onDarkSecondary: Color(0xB3F7F6F1),
    ringProgress: Color(0xFF9FC1AC),
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
    Color? authBg,
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
    Color? authShellDark,
    Color? atmosphereDeep,
    Color? atmosphereMid,
    Color? onDarkPrimary,
    Color? onDarkSecondary,
    Color? ringProgress,
  }) {
    return AppColorsX(
      bgApp: bgApp ?? this.bgApp,
      authBg: authBg ?? this.authBg,
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
      authShellDark: authShellDark ?? this.authShellDark,
      atmosphereDeep: atmosphereDeep ?? this.atmosphereDeep,
      atmosphereMid: atmosphereMid ?? this.atmosphereMid,
      onDarkPrimary: onDarkPrimary ?? this.onDarkPrimary,
      onDarkSecondary: onDarkSecondary ?? this.onDarkSecondary,
      ringProgress: ringProgress ?? this.ringProgress,
    );
  }

  @override
  AppColorsX lerp(ThemeExtension<AppColorsX>? other, double t) {
    if (other is! AppColorsX) return this;
    return AppColorsX(
      bgApp: Color.lerp(bgApp, other.bgApp, t)!,
      authBg: Color.lerp(authBg, other.authBg, t)!,
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
      authShellDark: Color.lerp(authShellDark, other.authShellDark, t)!,
      atmosphereDeep: Color.lerp(atmosphereDeep, other.atmosphereDeep, t)!,
      atmosphereMid: Color.lerp(atmosphereMid, other.atmosphereMid, t)!,
      onDarkPrimary: Color.lerp(onDarkPrimary, other.onDarkPrimary, t)!,
      onDarkSecondary: Color.lerp(onDarkSecondary, other.onDarkSecondary, t)!,
      ringProgress: Color.lerp(ringProgress, other.ringProgress, t)!,
    );
  }
}

/// Home material sampled from the approved cream/sage composition.
/// Kept separate from the darker clock and authentication surfaces.
class HomePalette {
  HomePalette._();
  static const cream = Color(0xFFF8F8F3);
  static const sage = Color(0xFFE5ECDD);
  static const pageMiddle = Color(0xFFF2F5EB);
  static const hero = Color(0xFF456B59);
  static const cardLight = Color(0xFF75B691);
  static const cardDark = Color(0xEB335040);
  static const stackMiddle = Color(0xFF5F8F77);
  static const stackBack = Color(0xFF789786);
  static const selected = Color(0xFF335040);
  static const panel = Color(0xFFF2F5EB);
  static const onGreenSecondary = Color(0xE6F7F6F1);
  static const greenTextShadow = Shadow(
    color: Color(0x99335040),
    blurRadius: 2,
    offset: Offset(0, .5),
  );
  static const cardGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [cardDark, cardLight],
  );
  // Use the existing slot depth so material follows the same card during motion.
  static LinearGradient stackGradient(double depth) {
    final d = depth.clamp(0.0, 2.0);
    final tone = Color.lerp(stackMiddle, stackBack, (d - 1).clamp(0.0, 1.0))!;
    return LinearGradient(
      begin: cardGradient.begin,
      end: cardGradient.end,
      colors: [
        Color.lerp(cardDark, tone, d.clamp(0.0, 1.0))!,
        Color.lerp(cardLight, tone, d.clamp(0.0, 1.0))!,
      ],
    );
  }

  static LinearGradient pageGradient(BuildContext context) => LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [
      background(context),
      Theme.of(context).brightness == Brightness.dark
          ? Color.lerp(background(context), atmosphere(context), .35)!
          : pageMiddle,
      atmosphere(context),
    ],
  );
  static Color background(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark
      ? context.colors.bgApp
      : cream;
  static Color atmosphere(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark
      ? context.colors.atmosphereMid
      : sage;
  static Color control(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark
      ? context.colors.bgSubtle
      : panel;
}

/// Home proportions and restrained elevation, shared by cards and route flights.
class HomeGeometry {
  HomeGeometry._();
  static const heroHeight = 146.0;
  static const heroRadius = 26.0;
  static const panelHeight = 136.0;
  static const panelRadius = 24.0;
  static const cardHeight = 224.0;
  static const cardRadius = 30.0;
  static const stackFront = 42.0;
  static const stackGap = 16.0;
  static const stackScale = .09;
  static const sectionGap = 18.0;
  static const smallShadow = [
    BoxShadow(color: Color(0x0A000000), blurRadius: 6, offset: Offset(0, 2)),
  ];
  static const cardShadow = [
    BoxShadow(color: Color(0x12000000), blurRadius: 14, offset: Offset(0, 4)),
  ];
  static const navShadow = [
    BoxShadow(color: Color(0x0F000000), blurRadius: 12, offset: Offset(0, 3)),
  ];
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
    required this.timerDisplay,
    required this.microLabel,
  });

  final TextStyle screenTitle;
  final TextStyle pageTitle;
  final TextStyle section;
  final TextStyle bodyMobile;
  final TextStyle label;
  final TextStyle metricMobile;

  /// The large Clock In/Out ring numerals — deliberately thin/light, unlike
  /// every other numeral style in the app, and always tabular so digits
  /// don't shift width as the live timer ticks.
  final TextStyle timerDisplay;

  /// Uppercase, wide-tracked micro copy: "YOUR SHIFT", "TIME REMAINING",
  /// "ASSIGNED VENUE", "TODAY'S ROLE" — restrained weight, small size.
  final TextStyle microLabel;

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
      timerDisplay: TextStyle(
        fontSize: 64,
        height: 1.0,
        fontWeight: FontWeight.w200,
        letterSpacing: -0.5,
        fontFeatures: const [FontFeature.tabularFigures()],
        color: c.onDarkPrimary,
      ),
      microLabel: TextStyle(
        fontSize: 11,
        height: 16 / 11,
        fontWeight: FontWeight.w600,
        letterSpacing: 1.6,
        color: c.onDarkSecondary,
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
    TextStyle? timerDisplay,
    TextStyle? microLabel,
  }) {
    return AppTextX(
      screenTitle: screenTitle ?? this.screenTitle,
      pageTitle: pageTitle ?? this.pageTitle,
      section: section ?? this.section,
      bodyMobile: bodyMobile ?? this.bodyMobile,
      label: label ?? this.label,
      metricMobile: metricMobile ?? this.metricMobile,
      timerDisplay: timerDisplay ?? this.timerDisplay,
      microLabel: microLabel ?? this.microLabel,
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
      timerDisplay: TextStyle.lerp(timerDisplay, other.timerDisplay, t)!,
      microLabel: TextStyle.lerp(microLabel, other.microLabel, t)!,
    );
  }
}

/// Global motion language (durations/curves) — every sheet/screen/button
/// transition in the app pulls from here rather than inlining its own
/// numbers, so the feel stays consistent app-wide.
class AppMotion {
  AppMotion._();

  static const buttonPress = Duration(milliseconds: 100);
  static const smallTransition = Duration(milliseconds: 200);
  static const tabTransition = Duration(milliseconds: 220);
  static const sheet = Duration(milliseconds: 380);
  static const screen = Duration(milliseconds: 400);
  static const sharedElement = Duration(milliseconds: 540);

  static const curve = Curves.easeOutCubic;
  static const curveInOut = Curves.easeInOutCubic;
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
