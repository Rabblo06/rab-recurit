import 'package:flutter/material.dart';

/// Account-security sizes, taken from the owner's design
/// (`docs/design/crewflow-account-security.html`, `.phone` rules). Colours
/// live in [SecurityColors] (light + dark), text styles in [SecurityType].
abstract final class SecurityTokens {
  static const pagePadding = 24.0;
  static const sectionGap = 24.0;
  static const cardRadius = 22.0;
  static const cardPadding = 20.0;
  static const pillRadius = 24.0;
  static const controlHeight = 48.0;
  static const inputRadius = 8.0;

  /// Recovery codes at or below this count get the "low" warning. Client
  /// constant (UI_PLAN §2, inventory E6); the count itself is the server's.
  static const lowRecoveryCodes = 3;
}

/// The security screens' palette. They follow the phone's light/dark setting
/// through the app's own `theme`/`darkTheme` (`ThemeMode.system`): [of] reads
/// the ambient [Theme] brightness. Other screens are unaffected.
///
/// Light = the design's `:root`, with the owner's text-only contrast decision:
/// green TEXT #007256 (not #008c69) and muted text on the canvas or a tinted
/// panel #5a6c84 (not #647892). Fills are the design's.
///
/// Dark = the design has no dark set, so each role is mapped to a cool,
/// navy-tinted dark equivalent: canvas → near-black, white cards → raised
/// surface, ink → near-white, tinted panels → low-luminance tints of the same
/// hue with a light text of that hue. The black pill inverts to a light pill
/// with dark text (a black pill on a black canvas would vanish). Every text
/// pair is ≥ 4.5:1 (WCAG AA), checked in `test/account_security_test.dart`.
@immutable
class SecurityColors {
  const SecurityColors({
    required this.brightness,
    required this.canvas,
    required this.surface,
    required this.ink,
    required this.muted,
    required this.mutedOnTint,
    required this.line,
    required this.cardLine,
    required this.pill,
    required this.onPill,
    required this.quiet,
    required this.red,
    required this.softRed,
    required this.dangerLine,
    required this.green,
    required this.greenText,
    required this.mint,
    required this.amber,
    required this.amberText,
    required this.placeholder,
    required this.avatarFill,
    required this.avatarText,
    required this.selection,
  });

  final Brightness brightness;

  /// Page background (`--canvas`).
  final Color canvas;

  /// Cards, inputs, OTP boxes, secondary buttons (`white`).
  final Color surface;

  /// Primary text (`--ink`).
  final Color ink;

  /// Muted text on [surface].
  final Color muted;

  /// Muted text on [canvas] and on tinted panels (notices, quiet badges).
  final Color mutedOnTint;
  final Color line;
  final Color cardLine;

  /// The phone's primary action fill, and its text.
  final Color pill;
  final Color onPill;
  final Color quiet;
  final Color red;
  final Color softRed;
  final Color dangerLine;

  /// Green fills and icons (emblem glyph, success icon).
  final Color green;

  /// Green text.
  final Color greenText;
  final Color mint;
  final Color amber;
  final Color amberText;

  /// The empty OTP box dash (decorative).
  final Color placeholder;
  final Color avatarFill;
  final Color avatarText;
  final Color selection;

  bool get isDark => brightness == Brightness.dark;

  static const light = SecurityColors(
    brightness: Brightness.light,
    canvas: Color(0xFFF7F7F9),
    surface: Color(0xFFFFFFFF),
    ink: Color(0xFF102235),
    muted: Color(0xFF647892),
    mutedOnTint: Color(0xFF5A6C84),
    line: Color(0xFFE1E4EB),
    cardLine: Color(0xFFE6E9EB),
    pill: Color(0xFF161916),
    onPill: Color(0xFFFFFFFF),
    quiet: Color(0xFFF0F1F4),
    red: Color(0xFFBB3438),
    softRed: Color(0xFFFCEFF0),
    dangerLine: Color(0xFFEABFC1),
    green: Color(0xFF008C69),
    greenText: Color(0xFF007256),
    mint: Color(0xFFE9F7F0),
    amber: Color(0xFFFFF3DD),
    amberText: Color(0xFF8C580B),
    placeholder: Color(0xFFA4ADBB),
    avatarFill: Color(0xFFDEDFFE),
    avatarText: Color(0xFF3F3E91),
    selection: Color(0x333663BD),
  );

  static const dark = SecurityColors(
    brightness: Brightness.dark,
    canvas: Color(0xFF0F1115),
    surface: Color(0xFF1A1D23),
    ink: Color(0xFFE9EDF3),
    muted: Color(0xFFA5B1C2),
    mutedOnTint: Color(0xFFAAB6C7),
    line: Color(0xFF30353E),
    cardLine: Color(0xFF2A2E36),
    pill: Color(0xFFE9EDF3),
    onPill: Color(0xFF111317),
    quiet: Color(0xFF252931),
    red: Color(0xFFFF8F93),
    softRed: Color(0xFF3A1D21),
    dangerLine: Color(0xFF6E3136),
    green: Color(0xFF3FCF9F),
    greenText: Color(0xFF63DCB0),
    mint: Color(0xFF12322A),
    amber: Color(0xFF3A2C12),
    amberText: Color(0xFFF2C36B),
    placeholder: Color(0xFF5E6775),
    avatarFill: Color(0xFF2D2E5E),
    avatarText: Color(0xFFCDCEFF),
    selection: Color(0x557FA2EB),
  );

  static SecurityColors of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

/// The design's type scale (platform font, owner decision), coloured from a
/// [SecurityColors] set: `SecurityType.of(context).h1`.
class SecurityType {
  const SecurityType(this.colors);
  final SecurityColors colors;

  static SecurityType of(BuildContext context) =>
      SecurityType(SecurityColors.of(context));

  TextStyle get h1 => TextStyle(
    fontSize: 25,
    height: 1.3,
    fontWeight: FontWeight.w600,
    letterSpacing: -0.7,
    color: colors.ink,
  );
  TextStyle get h2 => TextStyle(
    fontSize: 19,
    height: 1.35,
    fontWeight: FontWeight.w600,
    letterSpacing: -0.3,
    color: colors.ink,
  );
  TextStyle get h3 => TextStyle(
    fontSize: 14,
    height: 1.5,
    fontWeight: FontWeight.w600,
    color: colors.ink,
  );
  TextStyle get navTitle => TextStyle(
    fontSize: 15,
    height: 1.3,
    fontWeight: FontWeight.w600,
    color: colors.ink,
  );

  /// `.phone .body-copy` on the canvas: 12px, line-height 1.8.
  TextStyle get bodyCopy =>
      TextStyle(fontSize: 12, height: 1.8, color: colors.mutedOnTint);

  /// The same inside a card (muted on the surface).
  TextStyle get cardBody =>
      TextStyle(fontSize: 12, height: 1.8, color: colors.muted);
  TextStyle get small =>
      TextStyle(fontSize: 12, height: 1.5, color: colors.ink);
  TextStyle get tiny =>
      TextStyle(fontSize: 11, height: 1.5, color: colors.mutedOnTint);
  TextStyle get label => TextStyle(
    fontSize: 12,
    height: 1.5,
    fontWeight: FontWeight.w500,
    color: colors.mutedOnTint,
  );
  static const button = TextStyle(
    fontSize: 13,
    height: 1.2,
    fontWeight: FontWeight.w500,
  );
  TextStyle get link => TextStyle(
    fontSize: 12,
    height: 1.4,
    fontWeight: FontWeight.w500,
    color: colors.ink,
  );
  TextStyle get input =>
      TextStyle(fontSize: 14, height: 1.3, color: colors.ink);
}
