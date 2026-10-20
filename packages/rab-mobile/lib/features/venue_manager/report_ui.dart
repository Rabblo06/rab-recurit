import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/theme/schedule_tokens.dart';

/// Visual language of the Venue Manager Shift report / Review / Timesheet screens (owner reference designs
/// 2026-10-17): light neutral page, white rounded cards, dark navy actions, amber notices, mint / pink / lavender badges.
abstract final class ReportTokens {
  static const page = Color(0xFFF5F6F8);
  static const navy = Color(0xFF13233A);
  static const ink = Color(0xFF111827);
  static const muted = Color(0xFF6B7280);
  static const divider = Color(0xFFE6E7EB);
  static const amberBg = Color(0xFFFFF0DA);
  static const amberInk = Color(0xFF8A4B08);
  static const missing = Color(0xFFB45309);
  static const disabledBg = Color(0xFFE3E5EA);
  static const disabledInk = Color(0xFF9AA0A8);
  static const footerGlow = Color(0xFFFFF3C4);
}

enum ReportBadgeTone { waiting, needsReview, reviewed, neutral, info, awaiting }

extension on ReportBadgeTone {
  (Color, Color) get colors => switch (this) {
    ReportBadgeTone.waiting => (
      const Color(0xFFE2E4FF),
      const Color(0xFF4A4FBF),
    ),
    ReportBadgeTone.needsReview => (
      const Color(0xFFFFDDE0),
      const Color(0xFFC0263B),
    ),
    ReportBadgeTone.reviewed => (
      const Color(0xFFD9F6E1),
      const Color(0xFF1E7B3C),
    ),
    ReportBadgeTone.neutral => (
      const Color(0xFFEDEEF1),
      const Color(0xFF4B5563),
    ),
    ReportBadgeTone.info => (const Color(0xFFDDEBFB), const Color(0xFF1D4ED8)),
    ReportBadgeTone.awaiting => (
      const Color(0xFFF3E4D0),
      const Color(0xFF8A5A2B),
    ),
  };
}

class ReportBadge extends StatelessWidget {
  const ReportBadge(this.label, this.tone, {super.key, this.icon});
  final String label;
  final ReportBadgeTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = tone.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 14, color: fg),
            const SizedBox(width: 4),
          ],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: fg,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Amber notice: bold title + one supporting line.
class ReportNotice extends StatelessWidget {
  const ReportNotice({super.key, required this.title, this.message});
  final String title;
  final String? message;

  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: ReportTokens.amberBg,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w700,
              color: ReportTokens.amberInk,
            ),
          ),
          if (message != null) ...[
            const SizedBox(height: 3),
            Text(
              message!,
              style: const TextStyle(
                fontSize: 13,
                height: 1.35,
                color: ReportTokens.amberInk,
              ),
            ),
          ],
        ],
      ),
    ),
  );
}

class ReportCard extends StatelessWidget {
  const ReportCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.fromLTRB(18, 16, 18, 16),
  });
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: padding,
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(20),
    ),
    child: child,
  );
}

/// "Label    value" row used on staff report cards.
class ReportField extends StatelessWidget {
  const ReportField(this.label, this.value, {super.key, this.valueColor});
  final String label;
  final String value;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 96,
          child: Text(
            label,
            style: const TextStyle(fontSize: 13, color: ReportTokens.muted),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: TextStyle(
              fontSize: 14,
              color: valueColor ?? ReportTokens.ink,
              fontWeight: valueColor == null
                  ? FontWeight.w400
                  : FontWeight.w500,
            ),
          ),
        ),
      ],
    ),
  );
}

/// Full-width navy pill (primary) or white pill (secondary). Disabled primary turns light grey, as in the designs.
class ReportButton extends StatelessWidget {
  const ReportButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.secondary = false,
    this.busy = false,
    this.trailing,
  });
  final String label;
  final VoidCallback? onPressed;
  final bool secondary;
  final bool busy;
  final IconData? trailing;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    final bg = secondary
        ? Colors.white
        : (enabled || busy ? ReportTokens.navy : ReportTokens.disabledBg);
    final fg = secondary
        ? ReportTokens.ink
        : (enabled || busy ? Colors.white : ReportTokens.disabledInk);
    return SizedBox(
      width: double.infinity,
      height: 52,
      child: TextButton(
        onPressed: enabled ? onPressed : null,
        style: TextButton.styleFrom(
          backgroundColor: bg,
          foregroundColor: fg,
          disabledForegroundColor: fg,
          shape: StadiumBorder(
            side: secondary
                ? const BorderSide(color: ReportTokens.divider)
                : BorderSide.none,
          ),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
        child: busy
            ? SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: secondary ? ReportTokens.ink : Colors.white,
                ),
              )
            : Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
                  if (trailing != null) ...[
                    const SizedBox(width: 8),
                    Icon(trailing, size: 18),
                  ],
                ],
              ),
      ),
    );
  }
}

/// Fixed bottom actions above the safe area; optional soft yellow glow (Timesheet designs).
class ReportBottomBar extends StatelessWidget {
  const ReportBottomBar({super.key, required this.children, this.glow = false});
  final List<Widget> children;
  final bool glow;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      gradient: LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: glow
            ? [ReportTokens.page.withValues(alpha: 0), ReportTokens.footerGlow]
            : [ReportTokens.page, ReportTokens.page],
      ),
    ),
    padding: EdgeInsets.fromLTRB(
      20,
      12,
      20,
      12 + MediaQuery.paddingOf(context).bottom,
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) const SizedBox(height: 10),
          children[i],
        ],
      ],
    ),
  );
}

/// Two- or three-way segmented control: selected segment is a dark pill, the rest white.
class ReportSegments<T> extends StatelessWidget {
  const ReportSegments({
    super.key,
    required this.values,
    required this.labels,
    required this.selected,
    required this.onChanged,
  });
  final List<T> values;
  final List<String> labels;
  final T selected;
  final ValueChanged<T>? onChanged;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(4),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(14),
    ),
    child: Row(
      children: [
        for (var i = 0; i < values.length; i++)
          Expanded(
            child: Semantics(
              button: true,
              selected: values[i] == selected,
              child: GestureDetector(
                key: Key('segment-${labels[i]}'),
                onTap: onChanged == null ? null : () => onChanged!(values[i]),
                child: AnimatedContainer(
                  duration: ScheduleTokens.styleMotion,
                  height: 44,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: values[i] == selected
                        ? ReportTokens.navy
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: Text(
                    labels[i],
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: values[i] == selected
                          ? FontWeight.w600
                          : FontWeight.w400,
                      color: values[i] == selected
                          ? Colors.white
                          : ReportTokens.muted,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    ),
  );
}

/// Page scaffold for these screens: back arrow + title, neutral background, optional fixed bottom bar.
class ReportPage extends StatelessWidget {
  const ReportPage({
    super.key,
    required this.title,
    required this.body,
    this.bottom,
  });
  final String title;
  final Widget body;
  final Widget? bottom;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: ReportTokens.page,
    appBar: AppBar(
      backgroundColor: ReportTokens.page,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      titleSpacing: 4,
      title: Text(
        title,
        style: const TextStyle(
          fontSize: 22,
          fontWeight: FontWeight.w600,
          color: ReportTokens.ink,
        ),
      ),
    ),
    body: body,
    bottomNavigationBar: bottom,
  );
}

String reportTimeRange(DateTime start, DateTime end) {
  final s = start.toLocal(), e = end.toLocal();
  final overnight = s.year != e.year || s.month != e.month || s.day != e.day;
  return '${DateFormat('HH:mm').format(s)}–${DateFormat('HH:mm').format(e)}${overnight ? ' (+1)' : ''}';
}

String reportDate(DateTime d) => DateFormat('EEE d MMM').format(d.toLocal());
