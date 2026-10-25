import 'package:flutter/material.dart';

/// Account-security palette and type scale, taken from the owner's design
/// (`docs/design/crewflow-account-security.html`, `:root` + the `.phone`
/// rules). Light only, like Profile (owner decision: the security screens may
/// stay light). Platform font (no Plus Jakarta Sans in the app, owner
/// decision): only sizes, weights and tracking come from the design.
///
/// Contrast (owner decision): text-only darkening. Green TEXT is [greenText]
/// (#007256, 5.4:1 on mint) instead of #008c69; muted text on a tinted or
/// canvas background is [mutedOnTint] (#5a6c84, ≥ 4.7:1) instead of #647892
/// (4.0–4.2:1 there). Fills are unchanged.
abstract final class SecurityTokens {
  static const canvas = Color(0xFFF7F7F9);
  static const surface = Colors.white;
  static const ink = Color(0xFF102235);

  /// Muted text on white cards (4.5:1).
  static const muted = Color(0xFF647892);

  /// Muted text on the canvas and on tinted panels (notices, quiet badges).
  static const mutedOnTint = Color(0xFF5A6C84);
  static const line = Color(0xFFE1E4EB);
  static const cardLine = Color(0xFFE6E9EB);

  /// The phone's primary action: black pill, white text.
  static const pill = Color(0xFF161916);
  static const quiet = Color(0xFFF0F1F4);
  static const red = Color(0xFFBB3438);
  static const softRed = Color(0xFFFCEFF0);
  static const dangerLine = Color(0xFFEABFC1);

  /// Green fills and icons (emblem glyph, success icon).
  static const green = Color(0xFF008C69);

  /// Green text (owner contrast decision).
  static const greenText = Color(0xFF007256);
  static const mint = Color(0xFFE9F7F0);
  static const amber = Color(0xFFFFF3DD);
  static const amberText = Color(0xFF8C580B);
  static const placeholder = Color(0xFFA4ADBB);
  static const avatarFill = Color(0xFFDEDFFE);
  static const avatarText = Color(0xFF3F3E91);

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

abstract final class SecurityType {
  static const h1 = TextStyle(
    fontSize: 25,
    height: 1.3,
    fontWeight: FontWeight.w600,
    letterSpacing: -0.7,
    color: SecurityTokens.ink,
  );
  static const h2 = TextStyle(
    fontSize: 19,
    height: 1.35,
    fontWeight: FontWeight.w600,
    letterSpacing: -0.3,
    color: SecurityTokens.ink,
  );
  static const h3 = TextStyle(
    fontSize: 14,
    height: 1.5,
    fontWeight: FontWeight.w600,
    color: SecurityTokens.ink,
  );
  static const navTitle = TextStyle(
    fontSize: 15,
    height: 1.3,
    fontWeight: FontWeight.w600,
    color: SecurityTokens.ink,
  );

  /// `.phone .body-copy`: 12px, line-height 1.8.
  static const bodyCopy = TextStyle(
    fontSize: 12,
    height: 1.8,
    color: SecurityTokens.mutedOnTint,
  );
  static const small = TextStyle(
    fontSize: 12,
    height: 1.5,
    color: SecurityTokens.ink,
  );
  static const tiny = TextStyle(
    fontSize: 11,
    height: 1.5,
    color: SecurityTokens.mutedOnTint,
  );
  static const label = TextStyle(
    fontSize: 12,
    height: 1.5,
    fontWeight: FontWeight.w500,
    color: SecurityTokens.mutedOnTint,
  );
  static const button = TextStyle(
    fontSize: 13,
    height: 1.2,
    fontWeight: FontWeight.w500,
  );
  static const link = TextStyle(
    fontSize: 12,
    height: 1.4,
    fontWeight: FontWeight.w500,
    color: SecurityTokens.ink,
  );
  static const input = TextStyle(
    fontSize: 14,
    height: 1.3,
    color: SecurityTokens.ink,
  );
}
