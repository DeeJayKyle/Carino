import 'package:flutter/material.dart';

/// Carino's look: soft lavender surfaces and a violet brand colour, Material 3.
class CarinoColors {
  static const brand = Color(0xFF5B45DD);
  static const coral = Color(0xFFF26B5B);
  static const bgLight = Color(0xFFF7F5FC);
  static const surfaceLight = Color(0xFFFFFFFF);
  static const bgDark = Color(0xFF13111C);
  static const surfaceDark = Color(0xFF1C1928);
}

/// [midnight]: the deep blue-black palette from Settings → Appearance (dark mode only).
ThemeData carinoTheme(Brightness b, {bool midnight = false}) {
  final dark = b == Brightness.dark;
  final night = dark && midnight;
  final scheme = ColorScheme.fromSeed(seedColor: CarinoColors.brand, brightness: b).copyWith(
    primary: dark ? const Color(0xFFB4A8FF) : CarinoColors.brand,
    surface: night ? const Color(0xFF0E1424) : dark ? CarinoColors.surfaceDark : CarinoColors.surfaceLight,
    tertiary: CarinoColors.coral,
  );
  final bg = night ? const Color(0xFF070B16) : dark ? CarinoColors.bgDark : CarinoColors.bgLight;
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: bg,
    appBarTheme: AppBarTheme(backgroundColor: bg, surfaceTintColor: Colors.transparent, scrolledUnderElevation: 0, centerTitle: false),
    navigationBarTheme: NavigationBarThemeData(backgroundColor: scheme.surface, indicatorColor: scheme.primaryContainer, surfaceTintColor: Colors.transparent),
    cardTheme: CardThemeData(
      color: scheme.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.5))),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: scheme.surface,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: scheme.outlineVariant)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(16), borderSide: BorderSide(color: scheme.outlineVariant)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    ),
    chipTheme: ChipThemeData(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(99))),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
  );
}
