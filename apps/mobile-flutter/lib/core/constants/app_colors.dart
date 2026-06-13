// ============================================================
// Mirrors the canonical @swift/ui tokens (packages/ui/src/tokens.ts).
// When @swift/ui lands on main, regenerate to keep in sync:
//   pnpm --filter @swift/ui build:tokens
// ============================================================
import 'package:flutter/material.dart';

/// Swift design system colours — Guyana brand, red + white consumer surfaces.
class AppColors {
  AppColors._();

  // Brand / identity (Guyana Golden Arrowhead)
  static const brandRed = Color(0xFFCE1126);
  static const brandGreen = Color(0xFF009E49);
  static const brandGold = Color(0xFFFCD116);

  // Primary = brand red (consumer CTA / active accent). Surfaces stay white.
  static const primary = Color(0xFFCE1126);
  static const secondary = Color(0xFF009E49);

  // A soft red tint for icon chips / pressed states (red as accent, never a full bg)
  static const primarySoft = Color(0xFFFCE7E9);

  // Backgrounds / surfaces
  static const background = Color(0xFFF6F7F6);
  static const surface = Color(0xFFFFFFFF);
  static const inputBackground = Color(0xFFF1F2F1);

  // Text
  static const textPrimary = Color(0xFF14171A);
  static const textSecondary = Color(0xFF5B6166);
  static const textTertiary = Color(0xFF8A9097);

  // Borders
  static const border = Color(0xFFE6E8E6);
  static const divider = Color(0xFFE6E8E6);

  // Functional — reserved meanings
  static const success = Color(0xFF1B873F);
  static const error = Color(0xFFD32F2F);
  static const warning = Color(0xFFB26A00);
  static const alert = Color(0xFFCE1126);
  static const info = Color(0xFF1565C0);
}
