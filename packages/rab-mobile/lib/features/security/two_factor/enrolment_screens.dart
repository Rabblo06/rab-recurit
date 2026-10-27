import 'package:flutter/material.dart';

import '../security_platform.dart';
import '../security_tokens.dart';
import '../widgets/otp_code_field.dart';
import '../widgets/recovery_code_grid.dart';
import '../widgets/security_icon.dart';
import '../widgets/security_kit.dart';
import 'two_factor_api.dart';

/// Pops back to Profile > Security (the route that started the flow), or to
/// the first route when the flow was opened some other way (tests).
void popToSecurityHome(BuildContext context) {
  Navigator.of(context).popUntil(
    (route) => route.settings.name == kSecurityRouteName || route.isFirst,
  );
}

/// [RouteSettings.name] of Profile > Security (`SecurityScreen.route`).
const kSecurityRouteName = '/profile/security';

/// Design state `password` (M2): "Confirm it's you". Step 1 of 3.
class ConfirmIdentityScreen extends StatefulWidget {
  const ConfirmIdentityScreen({
    super.key,
    required this.api,
    required this.hasPassword,
  });
  final TwoFactorApi api;
  final bool hasPassword;

  @override
  State<ConfirmIdentityScreen> createState() => _ConfirmIdentityScreenState();
}

class _ConfirmIdentityScreenState extends State<ConfirmIdentityScreen> {
  final _password = TextEditingController();
  TwoFactorFailure? _failure;
  bool _busy = false;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  bool get _canContinue =>
      !_busy && (!widget.hasPassword || _password.text.isNotEmpty);

  Future<void> _continue() async {
    if (!_canContinue) return;
    setState(() {
      _busy = true;
      _failure = null;
    });
    try {
      final material = await widget.api.startEnrolment(
        currentPassword: widget.hasPassword ? _password.text : null,
      );
      if (!mounted) return;
      _password.clear();
      setState(() => _busy = false);
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              ConnectAuthenticatorScreen(api: widget.api, material: material),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _failure = TwoFactorFailure.from(
          error,
          hasPassword: widget.hasPassword,
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final failure = _failure;
    return SecurityPage(
      title: 'Set up 2FA',
      body: [
        const SecurityStepIndicator(step: 1),
        const SecurityEmblem(SecurityGlyph.lock),
        SecurityHeading(
          title: 'Confirm it’s you',
          body: widget.hasPassword
              ? 'Enter your current password to start protecting your Crewflow account.'
              : 'Your account signs in with Google or Microsoft, so there’s no password to enter. Continue to start protecting your Crewflow account.',
        ),
        if (widget.hasPassword)
          SecurityTextField(
            fieldKey: const ValueKey('current-password'),
            label: 'Current password',
            controller: _password,
            password: true,
            autofocus: true,
            error: failure?.field == TwoFactorFailureField.password,
            autofillHints: const [AutofillHints.password],
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => _continue(),
          ),
        if (failure != null)
          SecurityNotice(failure.message, kind: SecurityNoticeKind.error),
      ],
      actions: [
        SecurityButton(
          label: 'Continue',
          busy: _busy,
          onPressed: _canContinue ? _continue : null,
        ),
      ],
    );
  }
}

/// Design state `setup` (M3): same-phone setup. "Open authenticator app"
/// hands the server's `otpauth://` URI to the OS; the setup key + copy is the
/// fallback. No QR on mobile (owner decision). FLAG_SECURE while shown.
class ConnectAuthenticatorScreen extends StatefulWidget {
  const ConnectAuthenticatorScreen({
    super.key,
    required this.api,
    required this.material,
  });
  final TwoFactorApi api;
  final EnrolmentMaterial material;

  @override
  State<ConnectAuthenticatorScreen> createState() =>
      _ConnectAuthenticatorScreenState();
}

class _ConnectAuthenticatorScreenState
    extends State<ConnectAuthenticatorScreen> {
  final _code = TextEditingController();
  TwoFactorFailure? _failure;
  bool _launchFailed = false;
  bool _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  bool get _complete => _code.text.length == OtpCodeField.length;

  Future<void> _openAuthenticator() async {
    final uri = Uri.tryParse(widget.material.otpauthUri);
    final opened =
        uri != null &&
        uri.scheme == 'otpauth' &&
        await SecurityPlatform.instance.openAuthenticator(uri);
    if (mounted) setState(() => _launchFailed = !opened);
  }

  Future<void> _copyKey() async {
    await SecurityPlatform.instance.copySensitive(widget.material.compactKey);
    if (mounted) showSecuritySnack(context, 'Setup key copied');
  }

  Future<void> _confirm() async {
    if (!_complete || _busy) return;
    setState(() {
      _busy = true;
      _failure = null;
    });
    try {
      final codes = await widget.api.confirmEnrolment(_code.text);
      if (!mounted) return;
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => RecoveryCodesScreen(codes: codes),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _failure = TwoFactorFailure.from(error, hasPassword: true);
        // Keep the digits visible in red (design `invalid`); typing replaces them.
        _code.selection = TextSelection(
          baseOffset: 0,
          extentOffset: _code.text.length,
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final failure = _failure;
    final account = widget.material.accountName;
    return SecureWindow(
      child: SecurityPage(
        title: 'Set up 2FA',
        body: [
          const SecurityStepIndicator(step: 2),
          const SecurityEmblem(SecurityGlyph.phone),
          const SecurityHeading(
            title: 'Connect your authenticator',
            body:
                'Open an authenticator on this phone, or copy the setup key into your preferred app.',
          ),
          SecurityButton(
            label: 'Open authenticator app',
            glyph: SecurityGlyph.arrow,
            kind: SecurityButtonKind.secondary,
            onPressed: _openAuthenticator,
          ),
          if (_launchFailed)
            const SecurityNotice(
              'No authenticator app opened. Copy the setup key into your app instead.',
              kind: SecurityNoticeKind.warning,
            ),
          SetupKeyBox(manualKey: widget.material.manualKey, onCopy: _copyKey),
          if (account != null)
            Text('Account · $account', style: SecurityType.of(context).tiny),
          OtpCodeField(
            controller: _code,
            error: failure?.field == TwoFactorFailureField.code,
            enabled: !_busy,
            onChanged: (_) => setState(() {
              if (_failure?.field == TwoFactorFailureField.code) {
                _failure = null;
              }
            }),
          ),
          if (failure != null)
            SecurityNotice(failure.message, kind: SecurityNoticeKind.error),
        ],
        actions: [
          SecurityButton(
            label: 'Confirm code',
            busy: _busy,
            onPressed: _complete ? _confirm : null,
          ),
        ],
      ),
    );
  }
}

/// Design states `codes` (M4, step 3 of setup) and the new set after
/// "Get new recovery codes" (M13). Shown once: Done stays disabled until the
/// codes are acknowledged, and back navigation is held until then too.
/// FLAG_SECURE while shown. The codes live only in this widget's memory:
/// never stored, logged or sent anywhere except where the user shares them.
class RecoveryCodesScreen extends StatefulWidget {
  const RecoveryCodesScreen({
    super.key,
    required this.codes,
    this.regenerated = false,
  });
  final List<String> codes;
  final bool regenerated;

  @override
  State<RecoveryCodesScreen> createState() => _RecoveryCodesScreenState();
}

class _RecoveryCodesScreenState extends State<RecoveryCodesScreen> {
  bool _saved = false;
  bool _leaveBlocked = false;

  String get _plainText =>
      'Crewflow recovery codes\n\n${widget.codes.join('\n')}\n\n'
      'Each code works once.';

  Future<void> _share() => SecurityPlatform.instance.shareText(
    _plainText,
    subject: 'Crewflow recovery codes',
  );

  Future<void> _copy() async {
    await SecurityPlatform.instance.copySensitive(_plainText);
    if (mounted) showSecuritySnack(context, 'Recovery codes copied');
  }

  void _done() {
    if (!_saved) return;
    popToSecurityHome(context);
  }

  void _attemptLeave() {
    if (_saved) {
      _done();
    } else {
      setState(() => _leaveBlocked = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SecureWindow(
      child: PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _attemptLeave();
        },
        child: SecurityPage(
          title: widget.regenerated ? 'Security' : 'Set up 2FA',
          onBack: _attemptLeave,
          body: [
            if (!widget.regenerated) const SecurityStepIndicator(step: 3),
            SecurityHeading(
              title: widget.regenerated
                  ? 'Save your new recovery codes'
                  : 'Save your recovery codes',
              body: widget.regenerated
                  ? 'Your previous codes no longer work. Each new code works once, and won’t be shown again.'
                  : 'Use a code if you lose access to your authenticator. Each works once, and won’t be shown again.',
            ),
            RecoveryCodeGrid(codes: widget.codes),
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SecurityButton(
                  label: 'Share or save codes',
                  glyph: SecurityGlyph.download,
                  kind: SecurityButtonKind.secondary,
                  onPressed: _share,
                ),
                const SizedBox(height: 2),
                SecurityLink(label: 'Copy codes', onPressed: _copy),
              ],
            ),
            SecurityCheckRow(
              value: _saved,
              label: 'I’ve saved these codes somewhere safe.',
              onChanged: (value) => setState(() {
                _saved = value;
                if (value) _leaveBlocked = false;
              }),
            ),
            if (_leaveBlocked)
              const SecurityNotice(
                'Save your codes and tick the box before you leave. They won’t be shown again.',
                kind: SecurityNoticeKind.warning,
              ),
          ],
          actions: [
            SecurityButton(
              label: 'Done',
              onPressed: _saved ? _done : null,
              semanticsHint: _saved
                  ? null
                  : 'Tick “I’ve saved these codes somewhere safe” first',
            ),
          ],
        ),
      ),
    );
  }
}
