import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../security_tokens.dart';

/// `otp()`: six painted boxes over ONE real [TextField], so paste ("482 913"
/// lands whole), the platform's one-time-code autofill, selection, Backspace
/// and screen readers all behave like a normal field. Digits only, at most 6.
/// The boxes are decorative ([ExcludeSemantics]); the field carries the label.
class OtpCodeField extends StatefulWidget {
  const OtpCodeField({
    super.key,
    required this.controller,
    this.focusNode,
    this.label = '6-digit authentication code',
    this.error = false,
    this.enabled = true,
    this.autofocus = false,
    this.onChanged,
    this.onCompleted,
  });

  final TextEditingController controller;
  final FocusNode? focusNode;
  final String label;
  final bool error;
  final bool enabled;
  final bool autofocus;
  final ValueChanged<String>? onChanged;

  /// Called once a 6th digit is entered (the caller decides whether to submit).
  final ValueChanged<String>? onCompleted;

  static const length = 6;

  @override
  State<OtpCodeField> createState() => _OtpCodeFieldState();
}

class _OtpCodeFieldState extends State<OtpCodeField> {
  late FocusNode _focus = widget.focusNode ?? FocusNode();
  bool _ownsFocus = true;

  @override
  void initState() {
    super.initState();
    _ownsFocus = widget.focusNode == null;
    _focus.addListener(_rebuild);
    widget.controller.addListener(_rebuild);
  }

  @override
  void didUpdateWidget(OtpCodeField old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(_rebuild);
      widget.controller.addListener(_rebuild);
    }
    if (old.focusNode != widget.focusNode) {
      _focus.removeListener(_rebuild);
      if (_ownsFocus) _focus.dispose();
      _focus = widget.focusNode ?? FocusNode();
      _ownsFocus = widget.focusNode == null;
      _focus.addListener(_rebuild);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_rebuild);
    _focus.removeListener(_rebuild);
    if (_ownsFocus) _focus.dispose();
    super.dispose();
  }

  void _rebuild() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final value = widget.controller.text;
    final active = _focus.hasFocus && widget.enabled
        ? value.length.clamp(0, OtpCodeField.length - 1)
        : -1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ExcludeSemantics(
          child: Text(widget.label, style: SecurityType.of(context).label),
        ),
        const SizedBox(height: 8),
        SizedBox(
          height: SecurityTokens.controlHeight,
          child: Stack(
            children: [
              Positioned.fill(
                child: ExcludeSemantics(
                  child: Row(
                    children: [
                      for (var i = 0; i < OtpCodeField.length; i++) ...[
                        if (i > 0) const SizedBox(width: 8),
                        Expanded(
                          child: _Box(
                            char: i < value.length ? value[i] : null,
                            error: widget.error,
                            active: i == active,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              // The real input: covers the boxes so a tap anywhere focuses it,
              // long-press offers Paste; its own glyphs and caret are invisible.
              Positioned.fill(
                child: Theme(
                  data: Theme.of(context).copyWith(
                    textSelectionTheme: const TextSelectionThemeData(
                      selectionColor: Colors.transparent,
                      cursorColor: Colors.transparent,
                    ),
                  ),
                  child: MergeSemantics(
                    child: Semantics(
                      label: widget.label,
                      child: TextField(
                        key: const ValueKey('otp-input'),
                        controller: widget.controller,
                        focusNode: _focus,
                        enabled: widget.enabled,
                        autofocus: widget.autofocus,
                        keyboardType: TextInputType.number,
                        autofillHints: const [AutofillHints.oneTimeCode],
                        autocorrect: false,
                        enableSuggestions: false,
                        showCursor: false,
                        inputFormatters: const [_OtpFormatter()],
                        style: const TextStyle(
                          color: Colors.transparent,
                          fontSize: 1,
                          height: 1,
                        ),
                        decoration: const InputDecoration(
                          border: InputBorder.none,
                          counterText: '',
                          semanticCounterText: '',
                          isCollapsed: true,
                          contentPadding: EdgeInsets.symmetric(vertical: 20),
                        ),
                        onChanged: (text) {
                          widget.onChanged?.call(text);
                          if (text.length == OtpCodeField.length) {
                            widget.onCompleted?.call(text);
                          }
                        },
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Box extends StatelessWidget {
  const _Box({required this.char, required this.error, required this.active});
  final String? char;
  final bool error;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final c = SecurityColors.of(context);
    return Container(
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(SecurityTokens.inputRadius),
        border: Border.all(
          color: error
              ? c.red
              : active
              ? c.ink
              : c.line,
          width: active && !error ? 1.5 : 1,
        ),
      ),
      alignment: Alignment.center,
      child: Text(
        char ?? '—',
        style: TextStyle(
          fontSize: 21,
          height: 1.2,
          fontWeight: FontWeight.w500,
          // As in the design, digits take `.field`'s muted colour (4.5:1 on
          // white, large text); the empty dash is lighter.
          color: char == null ? c.placeholder : c.muted,
          fontFeatures: const [FontFeature.tabularFigures()],
        ),
      ),
    );
  }
}

/// Digits only, at most six. A whole code pasted or autofilled into a field
/// that already holds digits replaces them (the inserted digits win), so the
/// platform's one-time-code autofill and "paste" never get silently refused.
class _OtpFormatter extends TextInputFormatter {
  const _OtpFormatter();

  static String _digits(String value) =>
      value.replaceAll(RegExp(r'[^0-9]'), '');

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    var digits = _digits(newValue.text);
    if (digits.length > OtpCodeField.length) {
      final start = oldValue.selection.isValid
          ? oldValue.selection.start.clamp(0, newValue.text.length)
          : 0;
      final end = newValue.selection.isValid
          ? newValue.selection.end.clamp(start, newValue.text.length)
          : newValue.text.length;
      final inserted = _digits(newValue.text.substring(start, end));
      digits = (inserted.length >= OtpCodeField.length ? inserted : digits)
          .substring(0, OtpCodeField.length);
    }
    return TextEditingValue(
      text: digits,
      selection: TextSelection.collapsed(offset: digits.length),
    );
  }
}
