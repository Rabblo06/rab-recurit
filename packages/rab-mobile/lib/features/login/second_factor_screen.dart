import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../security/security_tokens.dart';
import '../security/widgets/otp_code_field.dart';
import '../security/widgets/security_icon.dart';
import '../security/widgets/security_kit.dart';

/// How the verification screen was left.
enum SecondFactorOutcome { signedIn, backToSignIn }

enum _View { code, recovery, expired, locked }

/// Design states `code`, `invalid`, `recovery` and `expired` (M7–M10): the
/// second step of a challenged sign-in, pushed by the login sheet when
/// [AuthProvider.login] throws [SecondFactorRequired]. All auth logic stays in
/// [AuthProvider] (`verifySecondFactor` / `cancelSecondFactor`); this screen
/// only collects the code and maps the server's stable failure codes:
///  - `MFA_CODE_INVALID` + `attemptsRemaining` → stay, show the server's count
///    (0 → "Let's start again");
///  - `MFA_CHALLENGE_EXPIRED` → expired; `MFA_CHALLENGE_EXHAUSTED` → locked;
///  - 429 (`MFA_RATE_LIMITED`) → a cooldown with the server's Retry-After.
/// Nothing is stored until the server accepts the code.
class SecondFactorScreen extends StatefulWidget {
  const SecondFactorScreen({super.key, this.email});

  /// The email typed on the password step (the design's account chip).
  final String? email;

  @override
  State<SecondFactorScreen> createState() => _SecondFactorScreenState();
}

class _SecondFactorScreenState extends State<SecondFactorScreen> {
  final _code = TextEditingController();
  final _recovery = TextEditingController();
  _View _view = _View.code;
  bool _busy = false;
  bool _invalid = false;
  String? _error;
  DateTime? _cooldownUntil;
  Timer? _cooldownTimer;

  @override
  void dispose() {
    _cooldownTimer?.cancel();
    _code.dispose();
    _recovery.dispose();
    super.dispose();
  }

  bool get _coolingDown =>
      _cooldownUntil != null && _cooldownUntil!.isAfter(DateTime.now());

  /// Never re-sends the code the server just rejected (it is still shown in
  /// red until the user changes it).
  bool get _canVerify =>
      !_busy &&
      !_coolingDown &&
      !_invalid &&
      (_view == _View.recovery
          ? _recovery.text.trim().length >= OtpCodeField.length
          : _code.text.length == OtpCodeField.length);

  Future<void> _verify() async {
    if (!_canVerify) return;
    final auth = context.read<AuthProvider>();
    final code = _view == _View.recovery
        ? _recovery.text.trim().toUpperCase()
        : _code.text;
    setState(() {
      _busy = true;
      _error = null;
      _invalid = false;
    });
    try {
      await auth.verifySecondFactor(code);
      if (!mounted) return;
      // Success: the server issued the session. Leave; AuthFlowShell / the
      // root gate move on from AuthProvider.phase.
      if (!auth.secondFactorPending && auth.user != null) {
        Navigator.of(context).pop(SecondFactorOutcome.signedIn);
        return;
      }
      setState(() => _busy = false);
    } on ApiException catch (e) {
      if (!mounted) return;
      _handleFailure(e, auth);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error =
            'Unable to reach the server. Check your connection and try again.';
      });
    }
  }

  void _handleFailure(ApiException e, AuthProvider auth) {
    setState(() {
      _busy = false;
      if (e.code == 'MFA_CODE_INVALID') {
        final remaining = e.body?['attemptsRemaining'];
        if (remaining is num && remaining <= 0) {
          _view = _View.locked;
          return;
        }
        _invalid = true;
        _error = _invalidMessage(remaining is num ? remaining.toInt() : null);
        final field = _view == _View.recovery ? _recovery : _code;
        field.selection = TextSelection(
          baseOffset: 0,
          extentOffset: field.text.length,
        );
        return;
      }
      if (e.statusCode == 429) {
        _error = e.message;
        _startCooldown(e.retryAfterSeconds ?? 60);
        return;
      }
      if (!auth.secondFactorPending) {
        _view = e.code == 'MFA_CHALLENGE_EXHAUSTED'
            ? _View.locked
            : _View.expired;
        return;
      }
      _error = e.userMessage;
    });
  }

  static String _invalidMessage(int? remaining) {
    const base = 'That code didn’t work. Check your app and try again.';
    if (remaining == null) return base;
    return '$base $remaining ${remaining == 1 ? 'try' : 'tries'} left.';
  }

  void _startCooldown(int seconds) {
    _cooldownUntil = DateTime.now().add(Duration(seconds: seconds));
    _cooldownTimer?.cancel();
    _cooldownTimer = Timer(Duration(seconds: seconds), () {
      if (mounted) setState(() => _cooldownUntil = null);
    });
  }

  Future<void> _backToSignIn() async {
    final navigator = Navigator.of(context);
    await context.read<AuthProvider>().cancelSecondFactor();
    if (mounted) navigator.pop(SecondFactorOutcome.backToSignIn);
  }

  void _showView(_View view) => setState(() {
    _view = view;
    _error = null;
    _invalid = false;
  });

  void _onBack() {
    if (_busy) return;
    if (_view == _View.recovery) {
      _showView(_View.code);
    } else {
      _backToSignIn();
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: false,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) _onBack();
    },
    child: switch (_view) {
      _View.code => _codeView(),
      _View.recovery => _recoveryView(),
      _View.expired || _View.locked => _restartView(),
    },
  );

  Widget _codeView() => SecurityPage(
    title: 'Verification',
    onBack: _onBack,
    body: [
      const SecurityEmblem(SecurityGlyph.shield),
      const SecurityHeading(
        title: 'Verify your sign-in',
        body:
            'Open your authenticator app and enter the 6-digit code for Crewflow.',
      ),
      if (widget.email != null && widget.email!.isNotEmpty)
        Text(
          widget.email!,
          style: TextStyle(
            fontSize: 12,
            height: 1.5,
            color: SecurityColors.of(context).mutedOnTint,
          ),
        ),
      OtpCodeField(
        controller: _code,
        autofocus: true,
        error: _invalid,
        enabled: !_busy,
        onChanged: (_) => setState(() => _invalid = false),
      ),
      if (_error != null)
        SecurityNotice(_error!, kind: SecurityNoticeKind.error),
    ],
    actions: [
      SecurityButton(
        label: 'Verify',
        busy: _busy,
        onPressed: _canVerify ? _verify : null,
      ),
      SecurityLink(
        label: 'Use a recovery code',
        onPressed: _busy ? null : () => _showView(_View.recovery),
      ),
    ],
  );

  Widget _recoveryView() => SecurityPage(
    title: 'Verification',
    onBack: _onBack,
    body: [
      const SecurityEmblem(SecurityGlyph.key),
      const SecurityHeading(
        title: 'Use a recovery code',
        body:
            'Enter one of the codes you saved when you turned on two-factor authentication.',
      ),
      SecurityTextField(
        fieldKey: const ValueKey('recovery-code'),
        label: 'Recovery code',
        controller: _recovery,
        hint: 'XXXX-XXXX-XXXX-XXXX',
        autofocus: true,
        error: _invalid,
        enabled: !_busy,
        keyboardType: TextInputType.visiblePassword,
        textCapitalization: TextCapitalization.characters,
        onChanged: (_) => setState(() => _invalid = false),
        onSubmitted: (_) => _verify(),
      ),
      if (_error != null)
        SecurityNotice(_error!, kind: SecurityNoticeKind.error)
      else
        const SecurityNotice('Each code can only be used once.'),
    ],
    actions: [
      SecurityButton(
        label: 'Verify recovery code',
        busy: _busy,
        onPressed: _canVerify ? _verify : null,
      ),
      SecurityLink(
        label: 'Use an authenticator code instead',
        onPressed: _busy ? null : () => _showView(_View.code),
      ),
    ],
  );

  /// One screen for an expired and a used-up challenge (the design merges
  /// them on mobile). No TTL number: the server sends none.
  Widget _restartView() {
    final locked = _view == _View.locked;
    return SecurityPage(
      title: 'Verification',
      onBack: _backToSignIn,
      body: [
        const SecurityEmblem(SecurityGlyph.refresh),
        SecurityHeading(
          title: 'Let’s start again',
          body: locked
              ? 'Too many incorrect codes were entered. Sign in with your password again to continue.'
              : 'Your verification session has expired. Sign in with your password again to continue.',
        ),
        SecurityNotice(
          locked
              ? 'Verification is temporarily unavailable for this session.'
              : 'Verification sessions expire after a few minutes.',
          kind: SecurityNoticeKind.warning,
        ),
      ],
      actions: [
        SecurityButton(label: 'Back to sign in', onPressed: _backToSignIn),
        const SecurityCaption(
          'Lost your phone and codes?\nContact your workspace admin or Crewflow support.',
        ),
      ],
    );
  }
}
