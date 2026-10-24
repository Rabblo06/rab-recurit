import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/rab_auth_sheet.dart';

import '../forgot_password/forgot_password_screen.dart';

/// Login's sheet content — same `AuthProvider.login()` call and error
/// handling as before; only the presentation moved (out of its own
/// `Scaffold` and into `AuthSheet`, staggered in via [reveal]).
class LoginSheetContent extends StatefulWidget {
  const LoginSheetContent({
    super.key,
    required this.reveal,
    this.reasonBanner,
    this.revealAnimation,
    this.onBiometric,
  });

  final double reveal;
  final VoidCallback? onBiometric;
  final Animation<double>? revealAnimation;
  final String? reasonBanner;

  @override
  State<LoginSheetContent> createState() => _LoginSheetContentState();
}

class _LoginSheetContentState extends State<LoginSheetContent> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  // Lane D (M10-1): the second-factor step (manager tiers with 2FA). Never persisted.
  final _codeController = TextEditingController();
  bool _codeStep = false;
  String _error = '';
  bool _loading = false;
  bool _obscurePassword = true;
  Timer? _cooldownTimer;
  DateTime? _cooldownUntil;
  bool get _coolingDown => _cooldownUntil?.isAfter(DateTime.now()) ?? false;

  @override
  void initState() {
    super.initState();
    _emailController.text = context.read<AuthProvider>().rememberedEmail ?? '';
  }

  @override
  void dispose() {
    _cooldownTimer?.cancel();
    _emailController.dispose();
    _passwordController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      _emailController.text.trim().isNotEmpty &&
      _passwordController.text.isNotEmpty &&
      !_loading &&
      !_coolingDown;

  Future<void> _signIn() async {
    if (!_canSubmit) return;
    setState(() {
      _error = '';
      _loading = true;
    });
    try {
      await context.read<AuthProvider>().login(
        _emailController.text.trim(),
        _passwordController.text,
      );
      // `AuthFlowShell` reacts to `AuthProvider.phase` on its own — no
      // Navigator pop needed here, unlike the old pushed-route version.
    } on SecondFactorRequired {
      if (!mounted) return;
      _codeController.clear();
      setState(() => _codeStep = true);
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.statusCode == 429) {
        _cooldownUntil = DateTime.now().add(
          Duration(seconds: e.retryAfterSeconds ?? 60),
        );
        _cooldownTimer?.cancel();
        _cooldownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
          if (!mounted) {
            timer.cancel();
            return;
          }
          setState(() {});
          if (!_coolingDown) timer.cancel();
        });
      }
      setState(
        () => _error = e.statusCode == 401
            ? 'Invalid email or password.'
            : e.statusCode >= 500
            ? 'Unable to sign in right now. Please try again.'
            : e.message,
      );
    } on SocketException catch (_) {
      if (!mounted) return;
      setState(
        () => _error =
            'Unable to reach the server. Check your connection and try again.',
      );
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Unable to reach the server. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  bool get _canVerify =>
      _codeController.text.replaceAll(' ', '').length >= 6 && !_loading;

  /// Lane D (M10-1): finishes the challenged sign-in. Wrong code → stays on the
  /// step; an expired / exhausted challenge → back to the password step.
  Future<void> _verifyCode() async {
    if (!_canVerify) return;
    final auth = context.read<AuthProvider>();
    setState(() {
      _error = '';
      _loading = true;
    });
    try {
      await auth.verifySecondFactor(_codeController.text);
    } on ApiException catch (e) {
      if (!mounted) return;
      final expired = !auth.secondFactorPending;
      setState(() {
        _codeController.clear();
        if (expired) _codeStep = false;
        _error = e.statusCode == 429
            ? e.message
            : expired
            ? 'Your sign-in expired. Please sign in again.'
            : e.statusCode == 401
            ? 'That code didn’t work. Check your authenticator app and try again.'
            : e.statusCode >= 500
            ? 'Unable to sign in right now. Please try again.'
            : e.message;
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Unable to reach the server. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _leaveCodeStep() async {
    await context.read<AuthProvider>().cancelSecondFactor();
    if (!mounted) return;
    setState(() {
      _codeStep = false;
      _error = '';
      _codeController.clear();
      _passwordController.clear();
    });
  }

  Widget _errorBox(BuildContext context) {
    final colors = context.colors;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpace.s3),
      decoration: BoxDecoration(
        color: colors.dangerSoft,
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Text(_error, style: TextStyle(color: colors.danger, fontSize: 13)),
    );
  }

  Widget _buildCodeStep(BuildContext context) {
    final text = context.text;
    return AuthContentLayout(
      biometric: false,
      children: [
        const AuthWelcomeHeading(),
        const SizedBox(height: 26),
        Center(
          child: Text(
            'Two-factor authentication',
            style: text.bodyMobile.copyWith(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: const Color(0xFF191D1A),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(
            'Enter the six-digit code from your authenticator app, or one of your recovery codes.',
            textAlign: TextAlign.center,
            style: text.label.copyWith(color: const Color(0xFF777D78)),
          ),
        ),
        const SizedBox(height: 20),
        _field(
          context,
          'CODE',
          _codeController,
          hint: '123 456',
          keyboardType: TextInputType.visiblePassword,
          autofillHints: const [AutofillHints.oneTimeCode],
        ),
        const SizedBox(height: 28),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (_error.isNotEmpty) ...[
                _errorBox(context),
                const SizedBox(height: 12),
              ],
              AuthPrimaryButton(
                label: _loading ? 'Verifying...' : 'Verify',
                icon: Icons.verified_user_outlined,
                busy: _loading,
                onPressed: _canVerify ? _verifyCode : null,
              ),
              Center(
                child: TextButton(
                  onPressed: _loading ? null : _leaveCodeStep,
                  style: TextButton.styleFrom(
                    foregroundColor: const Color(0xFF191D1A),
                    minimumSize: const Size(0, 48),
                  ),
                  child: const Text(
                    'Back to sign in',
                    style: TextStyle(fontWeight: FontWeight.w400),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
      ],
    );
  }

  Widget _reveal(int index, Widget child) {
    Widget frame(double progress, Widget content) {
      final local = ((progress - index * 0.125) / 0.625).clamp(0.0, 1.0);
      return IgnorePointer(
        ignoring: local < 1,
        child: Opacity(
          opacity: local,
          child: Transform.translate(
            offset: Offset(
              0,
              (widget.revealAnimation == null ? 10 : 32) * (1 - local),
            ),
            child: content,
          ),
        ),
      );
    }

    final animation = widget.revealAnimation;
    if (animation == null) return frame(widget.reveal, child);
    return AnimatedBuilder(
      animation: animation,
      child: child,
      builder: (context, child) => frame(animation.value, child!),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_codeStep) return _buildCodeStep(context);
    final colors = context.colors;
    final text = context.text;
    final form = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _reveal(0, const AuthWelcomeHeading()),
        const SizedBox(height: 26),
        Center(
          child: Text(
            widget.onBiometric != null
                ? 'Sign in with a password'
                : 'Sign in to your account',
            style: text.bodyMobile.copyWith(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: const Color(0xFF191D1A),
            ),
          ),
        ),
        const SizedBox(height: 20),
        if (widget.reasonBanner != null) ...[
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpace.s4),
            decoration: BoxDecoration(
              color: colors.bgSubtle,
              borderRadius: BorderRadius.circular(AppRadius.md),
            ),
            child: Row(
              children: [
                Icon(
                  Icons.shield_outlined,
                  size: 18,
                  color: colors.textSecondary,
                ),
                const SizedBox(width: AppSpace.s3),
                Expanded(
                  child: Text(
                    'For your security, please sign in again.',
                    style: text.label,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],
        _reveal(
          1,
          _field(
            context,
            'EMAIL',
            _emailController,
            hint: 'you@example.com',
            keyboardType: TextInputType.emailAddress,
          ),
        ),
        const SizedBox(height: 16),
        _reveal(
          2,
          _field(
            context,
            'PASSWORD',
            _passwordController,
            hint: 'Your password',
            obscure: _obscurePassword,
            trailing: IconButton(
              tooltip: _obscurePassword ? 'Show' : 'Hide',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints.tightFor(width: 40, height: 44),
              onPressed: () =>
                  setState(() => _obscurePassword = !_obscurePassword),
              icon: Icon(
                _obscurePassword
                    ? Icons.visibility_outlined
                    : Icons.visibility_off_outlined,
                size: 18,
                color: colors.textSecondary,
              ),
            ),
            topRight: TextButton(
              style: TextButton.styleFrom(
                padding: EdgeInsets.zero,
                minimumSize: const Size(0, 0),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => ForgotPasswordScreen(
                    initialEmail: _emailController.text.trim(),
                  ),
                ),
              ),
              child: Text(
                'Forgot password?',
                style: text.label.copyWith(
                  fontSize: 11,
                  color: const Color(0xFF0F5C3F),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ),
      ],
    );
    final action = _reveal(
      3,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_error.isNotEmpty) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpace.s3),
              decoration: BoxDecoration(
                color: colors.dangerSoft,
                borderRadius: BorderRadius.circular(AppRadius.sm),
              ),
              child: Text(
                _error,
                style: TextStyle(color: colors.danger, fontSize: 13),
              ),
            ),
            const SizedBox(height: 12),
          ],
          AuthPrimaryButton(
            label: _loading ? 'Signing in...' : 'Sign In',
            icon: Icons.key_outlined,
            busy: _loading,
            onPressed: _canSubmit ? _signIn : null,
          ),
          if (widget.onBiometric != null)
            Center(
              child: TextButton.icon(
                onPressed: _loading ? null : widget.onBiometric,
                icon: const Icon(Icons.fingerprint, size: 18),
                label: const Text(
                  'Continue with passkey',
                  style: TextStyle(fontWeight: FontWeight.w400),
                ),
                style: TextButton.styleFrom(
                  foregroundColor: const Color(0xFF191D1A),
                  minimumSize: const Size(0, 48),
                ),
              ),
            ),
        ],
      ),
    );
    return AuthContentLayout(
      biometric: widget.onBiometric != null,
      children: [
        form,
        const SizedBox(height: 28),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: action,
        ),
        const SizedBox(height: 12),
      ],
    );
  }

  Widget _field(
    BuildContext context,
    String label,
    TextEditingController controller, {
    String? hint,
    bool obscure = false,
    TextInputType? keyboardType,
    Widget? trailing,
    Widget? topRight,
    Iterable<String>? autofillHints,
  }) {
    final text = context.text;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                label,
                style: text.microLabel.copyWith(
                  fontSize: 10,
                  height: 1.2,
                  fontWeight: FontWeight.w500,
                  letterSpacing: 0.8,
                  color: const Color(0xFF777D78),
                ),
              ),
              if (topRight != null) Flexible(child: topRight),
            ],
          ),
          const SizedBox(height: 6),
          Container(
            height: 46,
            padding: const EdgeInsets.only(left: 14, right: 4),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFE3E5E1)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: controller,
                    obscureText: obscure,
                    keyboardType: keyboardType,
                    autofillHints: autofillHints,
                    autocorrect: false,
                    onChanged: (_) => setState(() {}),
                    style: text.bodyMobile.copyWith(
                      fontSize: 13,
                      color: const Color(0xFF191D1A),
                    ),
                    decoration: InputDecoration(
                      hintText: hint,
                      border: InputBorder.none,
                      isDense: true,
                    ),
                  ),
                ),
                ?trailing,
              ],
            ),
          ),
        ],
      ),
    );
  }
}
