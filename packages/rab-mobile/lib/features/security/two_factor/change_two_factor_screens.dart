import 'package:flutter/material.dart';

import '../widgets/otp_code_field.dart';
import '../widgets/security_icon.dart';
import '../widgets/security_kit.dart';
import 'enrolment_screens.dart';
import 'two_factor_api.dart';

/// Design state `disable` (M12): turn 2FA off. Proof per the API: the current
/// password (when the account has one) AND a current code — a TOTP or, via
/// "Use a recovery code instead", one recovery code. Success only on the
/// server's 204; the caller re-reads the status.
class TurnOffTwoFactorScreen extends StatelessWidget {
  const TurnOffTwoFactorScreen({
    super.key,
    required this.api,
    required this.hasPassword,
  });
  final TwoFactorApi api;
  final bool hasPassword;

  @override
  Widget build(BuildContext context) => _ProofScreen(
    hasPassword: hasPassword,
    glyph: SecurityGlyph.lock,
    title: 'Turn off two-factor authentication?',
    body: hasPassword
        ? 'Your password will be the only step needed to sign in.'
        : 'Google or Microsoft will be the only step needed to sign in.',
    warning: 'Your authenticator and recovery codes will stop working.',
    actionLabel: 'Turn off 2FA',
    actionKind: SecurityButtonKind.danger,
    submit: (password, code) async {
      await api.disable(currentPassword: password, code: code);
      if (context.mounted) Navigator.of(context).pop(true);
    },
  );
}

/// Design state `regenerate` (M13 input): replace the recovery codes. Same
/// proof as turning off; the new set opens on [RecoveryCodesScreen].
class RegenerateCodesScreen extends StatelessWidget {
  const RegenerateCodesScreen({
    super.key,
    required this.api,
    required this.hasPassword,
  });
  final TwoFactorApi api;
  final bool hasPassword;

  @override
  Widget build(BuildContext context) => _ProofScreen(
    hasPassword: hasPassword,
    glyph: SecurityGlyph.key,
    title: 'Get new recovery codes',
    body: 'Confirm your identity to replace your current recovery codes.',
    warning:
        'All previous recovery codes will stop working. Save your new set.',
    actionLabel: 'Generate new codes',
    actionKind: SecurityButtonKind.primary,
    submit: (password, code) async {
      final codes = await api.regenerateRecoveryCodes(
        currentPassword: password,
        code: code,
      );
      if (!context.mounted) return;
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => RecoveryCodesScreen(codes: codes, regenerated: true),
        ),
      );
    },
  );
}

typedef _Submit = Future<void> Function(String? password, String code);

class _ProofScreen extends StatefulWidget {
  const _ProofScreen({
    required this.hasPassword,
    required this.glyph,
    required this.title,
    required this.body,
    required this.warning,
    required this.actionLabel,
    required this.actionKind,
    required this.submit,
  });

  final bool hasPassword;
  final SecurityGlyph glyph;
  final String title;
  final String body;
  final String warning;
  final String actionLabel;
  final SecurityButtonKind actionKind;
  final _Submit submit;

  @override
  State<_ProofScreen> createState() => _ProofScreenState();
}

class _ProofScreenState extends State<_ProofScreen> {
  final _password = TextEditingController();
  final _code = TextEditingController();
  final _recovery = TextEditingController();
  bool _useRecovery = false;
  bool _busy = false;
  TwoFactorFailure? _failure;

  @override
  void dispose() {
    _password.dispose();
    _code.dispose();
    _recovery.dispose();
    super.dispose();
  }

  String get _proofCode =>
      _useRecovery ? _recovery.text.trim().toUpperCase() : _code.text;

  bool get _ready =>
      !_busy &&
      (!widget.hasPassword || _password.text.isNotEmpty) &&
      (_useRecovery
          ? _recovery.text.trim().length >= OtpCodeField.length
          : _code.text.length == OtpCodeField.length);

  Future<void> _submit() async {
    if (!_ready) return;
    setState(() {
      _busy = true;
      _failure = null;
    });
    try {
      await widget.submit(
        widget.hasPassword ? _password.text : null,
        _proofCode,
      );
    } catch (error) {
      if (!mounted) return;
      final failure = TwoFactorFailure.from(
        error,
        hasPassword: widget.hasPassword,
      );
      setState(() {
        _busy = false;
        _failure = failure;
        if (failure.field == TwoFactorFailureField.code) {
          _code.selection = TextSelection(
            baseOffset: 0,
            extentOffset: _code.text.length,
          );
        }
      });
    }
  }

  void _clearFieldError(TwoFactorFailureField field) {
    if (_failure?.field == field) _failure = null;
  }

  @override
  Widget build(BuildContext context) {
    final failure = _failure;
    final codeError = failure?.field == TwoFactorFailureField.code;
    return SecurityPage(
      title: 'Security',
      body: [
        SecurityEmblem(widget.glyph),
        SecurityHeading(title: widget.title, body: widget.body),
        if (widget.hasPassword)
          SecurityTextField(
            fieldKey: const ValueKey('current-password'),
            label: 'Current password',
            controller: _password,
            password: true,
            enabled: !_busy,
            error: failure?.field == TwoFactorFailureField.password,
            autofillHints: const [AutofillHints.password],
            onChanged: (_) => setState(
              () => _clearFieldError(TwoFactorFailureField.password),
            ),
          ),
        // The code and its alternative belong together (one section).
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_useRecovery)
              SecurityTextField(
                fieldKey: const ValueKey('recovery-code'),
                label: 'Recovery code',
                controller: _recovery,
                hint: 'XXXX-XXXX-XXXX-XXXX',
                enabled: !_busy,
                error: codeError,
                keyboardType: TextInputType.visiblePassword,
                textCapitalization: TextCapitalization.characters,
                onChanged: (_) => setState(
                  () => _clearFieldError(TwoFactorFailureField.code),
                ),
              )
            else
              OtpCodeField(
                controller: _code,
                enabled: !_busy,
                error: codeError,
                onChanged: (_) => setState(
                  () => _clearFieldError(TwoFactorFailureField.code),
                ),
              ),
            const SizedBox(height: 4),
            Align(
              alignment: Alignment.centerLeft,
              child: SecurityLink(
                label: _useRecovery
                    ? 'Use an authenticator code instead'
                    : 'Use a recovery code instead',
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _useRecovery = !_useRecovery;
                        _clearFieldError(TwoFactorFailureField.code);
                      }),
              ),
            ),
          ],
        ),
        if (failure != null)
          SecurityNotice(failure.message, kind: SecurityNoticeKind.error),
        SecurityNotice(widget.warning, kind: SecurityNoticeKind.warning),
      ],
      actions: [
        SecurityButton(
          label: widget.actionLabel,
          kind: widget.actionKind,
          busy: _busy,
          onPressed: _ready ? _submit : null,
        ),
        SecurityLink(
          label: 'Cancel',
          onPressed: _busy ? null : () => Navigator.of(context).maybePop(),
        ),
      ],
    );
  }
}
