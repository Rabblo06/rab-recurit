import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../security_tokens.dart';
import 'security_icon.dart';

/// The account-security primitives (design helpers `btn`, `link`, `badge`,
/// `notice`, `emblem`, `field`, `steps`, the `.phone .card`, `.mobile-nav`,
/// `.mobile-body` and `.mobile-actions` rules), shared by Profile > Security
/// and the sign-in verification screens.

/// `.mobile-nav` + `.mobile-body` + `.mobile-actions` inside the app's real
/// navigation and safe areas (no phone frame, status bar or home indicator).
class SecurityPage extends StatelessWidget {
  const SecurityPage({
    super.key,
    required this.title,
    required this.body,
    this.actions = const [],
    this.onBack,
    this.scrollController,
  });

  final String title;
  final List<Widget> body;
  final List<Widget> actions;

  /// Null = `Navigator.maybePop` (which honours a [PopScope]).
  final VoidCallback? onBack;
  final ScrollController? scrollController;

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewPaddingOf(context).bottom;
    final c = SecurityColors.of(context);
    return Theme(
      data: Theme.of(context).copyWith(
        scaffoldBackgroundColor: c.canvas,
        textSelectionTheme: TextSelectionThemeData(
          cursorColor: c.ink,
          selectionColor: c.selection,
          selectionHandleColor: c.ink,
        ),
      ),
      child: Scaffold(
        backgroundColor: c.canvas,
        body: SafeArea(
          bottom: false,
          child: Column(
            children: [
              SecurityHeader(title: title, onBack: onBack),
              Expanded(
                child: SingleChildScrollView(
                  controller: scrollController,
                  padding: EdgeInsets.fromLTRB(
                    SecurityTokens.pagePadding,
                    SecurityTokens.pagePadding,
                    SecurityTokens.pagePadding,
                    actions.isEmpty
                        ? SecurityTokens.pagePadding + bottomInset
                        : SecurityTokens.pagePadding,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: _gapped(body, SecurityTokens.sectionGap),
                  ),
                ),
              ),
              if (actions.isNotEmpty)
                Container(
                  color: c.canvas,
                  // A text link's 48px hit area already carries ~14px of
                  // space: trim the design's 16px gap / 18px bottom by that
                  // much so the VISIBLE spacing matches the design.
                  padding: EdgeInsets.fromLTRB(
                    24,
                    16,
                    24,
                    (actions.last is SecurityLink ? 4 : 18) + bottomInset,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (var i = 0; i < actions.length; i++) ...[
                        if (i > 0)
                          SizedBox(height: actions[i] is SecurityLink ? 2 : 16),
                        actions[i],
                      ],
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

List<Widget> _gapped(List<Widget> children, double gap) => [
  for (var i = 0; i < children.length; i++) ...[
    if (i > 0) SizedBox(height: gap),
    children[i],
  ],
];

/// `.mobile-nav`: 56px, a 36px rounded-square back control (48px hit area),
/// centred 15px title, a 36px spacer.
class SecurityHeader extends StatelessWidget {
  const SecurityHeader({super.key, required this.title, this.onBack});
  final String title;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final c = SecurityColors.of(context);
    return SizedBox(
      height: 56,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        child: Row(
          children: [
            SizedBox.square(
              dimension: 48,
              child: Semantics(
                button: true,
                label: 'Back',
                child: InkResponse(
                  key: const ValueKey('security-back'),
                  onTap: onBack ?? () => Navigator.maybePop(context),
                  radius: 24,
                  child: Center(
                    child: Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        color: c.surface,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: c.line),
                      ),
                      alignment: Alignment.center,
                      child: SecurityIcon(SecurityGlyph.back, color: c.ink),
                    ),
                  ),
                ),
              ),
            ),
            Expanded(
              child: Semantics(
                header: true,
                child: Text(
                  title,
                  textAlign: TextAlign.center,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SecurityType(c).navTitle,
                ),
              ),
            ),
            const SizedBox(width: 48),
          ],
        ),
      ),
    );
  }
}

/// `.phone .card`: white, 22px radius, 20px padding, `.stack` 20px gaps.
class SecurityCard extends StatelessWidget {
  const SecurityCard({
    super.key,
    required this.children,
    this.gap = 20,
    this.padding = const EdgeInsets.all(SecurityTokens.cardPadding),
  });
  final List<Widget> children;
  final double gap;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Container(
    padding: padding,
    decoration: BoxDecoration(
      color: SecurityColors.of(context).surface,
      borderRadius: BorderRadius.circular(SecurityTokens.cardRadius),
      border: Border.all(color: SecurityColors.of(context).cardLine),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: _gapped(children, gap),
    ),
  );
}

enum SecurityButtonKind { primary, secondary, danger }

/// `.phone .btn`: 48px pill. Primary = the pill fill (black in light, light in
/// dark) + its text; secondary = surface + line border; danger = surface + red
/// text and a red-tint border.
class SecurityButton extends StatelessWidget {
  const SecurityButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.kind = SecurityButtonKind.primary,
    this.glyph,
    this.busy = false,
    this.semanticsHint,
  });

  final String label;
  final VoidCallback? onPressed;
  final SecurityButtonKind kind;
  final SecurityGlyph? glyph;
  final bool busy;

  /// Read with the disabled state (e.g. why Done is not available yet).
  final String? semanticsHint;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    final c = SecurityColors.of(context);
    final (fill, border, ink) = switch (kind) {
      SecurityButtonKind.primary => (c.pill, c.pill, c.onPill),
      SecurityButtonKind.secondary => (c.surface, c.line, c.ink),
      SecurityButtonKind.danger => (c.surface, c.dangerLine, c.red),
    };
    final content = Row(
      mainAxisAlignment: MainAxisAlignment.center,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (busy)
          SizedBox.square(
            dimension: 16,
            child: CircularProgressIndicator(strokeWidth: 2, color: ink),
          )
        else if (glyph != null)
          SecurityIcon(glyph!, color: ink),
        if (busy || glyph != null) const SizedBox(width: 8),
        Flexible(
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: SecurityType.button.copyWith(color: ink),
          ),
        ),
      ],
    );
    return Semantics(
      hint: semanticsHint,
      child: Opacity(
        opacity: enabled || busy ? 1 : .55,
        child: Material(
          color: fill,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(SecurityTokens.pillRadius),
            side: BorderSide(color: border),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: enabled ? onPressed : null,
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: SecurityTokens.controlHeight,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                child: Center(child: content),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// `.link`: bare 12px/500 ink text button, centred in `.mobile-actions`,
/// with a 48px-tall hit area.
class SecurityLink extends StatelessWidget {
  const SecurityLink({
    super.key,
    required this.label,
    required this.onPressed,
    this.color,
  });
  final String label;
  final VoidCallback? onPressed;

  /// Defaults to the palette's ink.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final link = SecurityType.of(context).link;
    return Center(
      child: TextButton(
        onPressed: onPressed,
        style: TextButton.styleFrom(
          foregroundColor: color ?? link.color,
          minimumSize: const Size(48, 40),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          tapTargetSize: MaterialTapTargetSize.padded,
          // A ButtonStyle text style replaces the theme's: keep its font.
          textStyle:
              Theme.of(context).textTheme.labelLarge?.merge(link) ?? link,
        ),
        child: Text(label),
      ),
    );
  }
}

/// `badge()`: On (mint + green text) / Off (quiet + muted).
class SecurityBadge extends StatelessWidget {
  const SecurityBadge({super.key, required this.on, this.text});
  final bool on;
  final String? text;

  @override
  Widget build(BuildContext context) {
    final c = SecurityColors.of(context);
    final color = on ? c.greenText : c.mutedOnTint;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: on ? c.mint : c.quiet,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 5,
            height: 5,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(
            text ?? (on ? 'On' : 'Off'),
            style: TextStyle(
              fontSize: 11,
              height: 1.5,
              fontWeight: FontWeight.w500,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

enum SecurityNoticeKind { info, warning, error, success }

/// `notice()`: tinted panel, 17px icon, 11px text (phone). Errors are a live
/// region and are also announced when they first appear.
class SecurityNotice extends StatefulWidget {
  const SecurityNotice(
    this.message, {
    super.key,
    this.kind = SecurityNoticeKind.info,
  });
  final String message;
  final SecurityNoticeKind kind;

  @override
  State<SecurityNotice> createState() => _SecurityNoticeState();
}

class _SecurityNoticeState extends State<SecurityNotice> {
  @override
  void initState() {
    super.initState();
    _announce();
  }

  @override
  void didUpdateWidget(SecurityNotice old) {
    super.didUpdateWidget(old);
    if (old.message != widget.message) _announce();
  }

  void _announce() {
    if (widget.kind != SecurityNoticeKind.error) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      SemanticsService.sendAnnouncement(
        View.of(context),
        widget.message,
        Directionality.of(context),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = SecurityColors.of(context);
    final (fill, ink) = switch (widget.kind) {
      SecurityNoticeKind.info => (c.quiet, c.mutedOnTint),
      SecurityNoticeKind.warning => (c.amber, c.amberText),
      SecurityNoticeKind.error => (c.softRed, c.red),
      SecurityNoticeKind.success => (c.mint, c.greenText),
    };
    return Semantics(
      liveRegion: widget.kind == SecurityNoticeKind.error,
      container: true,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: SecurityIcon(
                widget.kind == SecurityNoticeKind.success
                    ? SecurityGlyph.check
                    : SecurityGlyph.info,
                size: 17,
                color: ink,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                widget.message,
                style: TextStyle(fontSize: 11, height: 1.5, color: ink),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// `emblem()` inside `.phone`: 58px mint tile, 20px radius, 26px green glyph.
class SecurityEmblem extends StatelessWidget {
  const SecurityEmblem(this.glyph, {super.key});
  final SecurityGlyph glyph;

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerLeft,
    child: Container(
      width: 58,
      height: 58,
      decoration: BoxDecoration(
        color: SecurityColors.of(context).mint,
        borderRadius: BorderRadius.circular(20),
      ),
      alignment: Alignment.center,
      child: SecurityIcon(
        glyph,
        size: 26,
        color: SecurityColors.of(context).green,
      ),
    ),
  );
}

/// The design's `<h1>` + `.body-copy` (margin-top 10) block.
class SecurityHeading extends StatelessWidget {
  const SecurityHeading({super.key, required this.title, required this.body});
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Semantics(
        header: true,
        child: Text(title, style: SecurityType.of(context).h1),
      ),
      const SizedBox(height: 10),
      Text(body, style: SecurityType.of(context).bodyCopy),
    ],
  );
}

/// `steps(n)`: three columns, 3px top rule (black when reached), 10px labels.
class SecurityStepIndicator extends StatelessWidget {
  const SecurityStepIndicator({super.key, required this.step});

  /// 1-based current step.
  final int step;
  static const labels = ['Confirm identity', 'Connect app', 'Save codes'];

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Step $step of ${labels.length}: ${labels[step - 1]}',
    child: ExcludeSemantics(
      child: Row(
        children: [
          for (var i = 0; i < labels.length; i++) ...[
            if (i > 0) const SizedBox(width: 8),
            Expanded(
              child: Container(
                padding: const EdgeInsets.only(top: 10),
                decoration: BoxDecoration(
                  border: Border(
                    top: BorderSide(
                      width: 3,
                      color: i < step
                          ? SecurityColors.of(context).pill
                          : SecurityColors.of(context).line,
                    ),
                  ),
                ),
                child: Text(
                  labels[i],
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 10,
                    height: 1.5,
                    fontWeight: i == step - 1
                        ? FontWeight.w600
                        : FontWeight.w400,
                    color: i < step
                        ? SecurityColors.of(context).ink
                        : SecurityColors.of(context).mutedOnTint,
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    ),
  );
}

/// `field()`: 12px label above a 48px input with an 8px radius. A password
/// field gets the design's eye toggle.
class SecurityTextField extends StatefulWidget {
  const SecurityTextField({
    super.key,
    required this.label,
    required this.controller,
    this.password = false,
    this.error = false,
    this.hint,
    this.autofillHints,
    this.keyboardType,
    this.textCapitalization = TextCapitalization.none,
    this.onChanged,
    this.onSubmitted,
    this.autofocus = false,
    this.enabled = true,
    this.fieldKey,
  });

  final String label;
  final TextEditingController controller;
  final bool password;
  final bool error;
  final String? hint;
  final Iterable<String>? autofillHints;
  final TextInputType? keyboardType;
  final TextCapitalization textCapitalization;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;
  final bool enabled;
  final Key? fieldKey;

  @override
  State<SecurityTextField> createState() => _SecurityTextFieldState();
}

class _SecurityTextFieldState extends State<SecurityTextField> {
  bool _obscure = true;

  @override
  Widget build(BuildContext context) {
    final c = SecurityColors.of(context);
    final t = SecurityType(c);
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(SecurityTokens.inputRadius),
      borderSide: BorderSide(color: widget.error ? c.red : c.line),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ExcludeSemantics(child: Text(widget.label, style: t.label)),
        const SizedBox(height: 8),
        SizedBox(
          height: SecurityTokens.controlHeight,
          child: MergeSemantics(
            child: Semantics(
              label: widget.label,
              child: TextField(
                key: widget.fieldKey,
                controller: widget.controller,
                enabled: widget.enabled,
                autofocus: widget.autofocus,
                obscureText: widget.password && _obscure,
                enableSuggestions: !widget.password,
                autocorrect: false,
                autofillHints: widget.autofillHints,
                keyboardType: widget.keyboardType,
                textCapitalization: widget.textCapitalization,
                onChanged: widget.onChanged,
                onSubmitted: widget.onSubmitted,
                style: t.input,
                textAlignVertical: TextAlignVertical.center,
                decoration: InputDecoration(
                  hintText: widget.hint,
                  hintStyle: t.input.copyWith(color: c.placeholder),
                  semanticCounterText: '',
                  filled: true,
                  fillColor: c.surface,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 14,
                  ),
                  border: border,
                  enabledBorder: border,
                  disabledBorder: border,
                  focusedBorder: border.copyWith(
                    borderSide: BorderSide(
                      color: widget.error ? c.red : c.ink,
                      width: 1.5,
                    ),
                  ),
                  suffixIcon: widget.password
                      ? IconButton(
                          tooltip: _obscure ? 'Show password' : 'Hide password',
                          onPressed: () => setState(() => _obscure = !_obscure),
                          icon: SecurityIcon(
                            _obscure ? SecurityGlyph.eye : SecurityGlyph.eyeOff,
                            size: 18,
                            color: c.muted,
                          ),
                        )
                      : null,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// `.check`: a real, labelled checkbox; the whole 48px row toggles it.
class SecurityCheckRow extends StatelessWidget {
  const SecurityCheckRow({
    super.key,
    required this.value,
    required this.onChanged,
    required this.label,
  });
  final bool value;
  final ValueChanged<bool> onChanged;
  final String label;

  @override
  Widget build(BuildContext context) {
    final c = SecurityColors.of(context);
    return MergeSemantics(
      child: InkWell(
        onTap: () => onChanged(!value),
        borderRadius: BorderRadius.circular(8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Row(
            children: [
              SizedBox.square(
                dimension: 16,
                child: Checkbox(
                  value: value,
                  onChanged: (v) => onChanged(v ?? false),
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  visualDensity: VisualDensity.compact,
                  activeColor: c.pill,
                  checkColor: c.onPill,
                  side: BorderSide(color: c.muted, width: 1.2),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(child: Text(label, style: SecurityType(c).small)),
            ],
          ),
        ),
      ),
    );
  }
}

/// `.caption`: 11px muted, centred.
class SecurityCaption extends StatelessWidget {
  const SecurityCaption(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    textAlign: TextAlign.center,
    style: SecurityType.of(context).tiny,
  );
}

/// One-line feedback after a server-confirmed change (never instead of it).
void showSecuritySnack(BuildContext context, String message) {
  final c = SecurityColors.of(context);
  ScaffoldMessenger.maybeOf(context)
    ?..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(message, style: TextStyle(color: c.onPill)),
        behavior: SnackBarBehavior.floating,
        backgroundColor: c.pill,
        duration: const Duration(seconds: 3),
      ),
    );
}
