import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/tokens.dart';
import '../forgot_password/forgot_password_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, this.reasonBanner});

  /// Shown above the form when non-null — used for the periodic
  /// full-reauthentication flow ("For your security, please sign in
  /// again.") rather than a separate duplicated screen. `null` (the
  /// default) is the plain first-login/manual-login case and renders
  /// nothing extra, unchanged from before.
  final String? reasonBanner;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  String _error = '';
  bool _loading = false;
  bool _obscurePassword = true;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      _emailController.text.trim().isNotEmpty &&
      _passwordController.text.isNotEmpty &&
      !_loading;

  Future<void> _signIn() async {
    setState(() {
      _error = '';
      _loading = true;
    });
    try {
      await context.read<AuthProvider>().login(
            _emailController.text.trim(),
            _passwordController.text,
          );
      // `_RootGate` (the app's root widget) reacts to `AuthProvider.phase`
      // and renders the right next screen (Home, forced password reset,
      // biometric setup...) on its own — but when this screen was reached
      // via `Navigator.push` (the Welcome -> Login path), it sits on top of
      // `_RootGate` in the navigation stack, and rebuilding `_RootGate`
      // underneath does nothing to a route already pushed on top of it. Pop
      // back to the root so that freshly-rendered screen actually becomes
      // visible, instead of leaving this login form stuck on screen after a
      // successful login.
      if (mounted && Navigator.of(context).canPop()) {
        Navigator.of(context).popUntil((route) => route.isFirst);
      }
    } on ApiException catch (e) {
      // The backend's own wording for a bad login is already correct
      // ("Invalid email or password.") — this just guarantees a clear,
      // consistent message on this specific screen even if that wording
      // ever changes server-side, since 401 here always means one thing.
      setState(() => _error = e.statusCode == 401 ? 'Incorrect email or password.' : e.message);
    } on SocketException catch (_) {
      setState(() => _error = "Can't reach the server. Check your connection and try again.");
    } catch (_) {
      setState(() => _error = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _showCreateAccountInfo() {
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Staff accounts are provisioned'),
        content: const Text('Staff accounts are created by your manager or admin. Contact them to request access.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('OK')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final canPop = Navigator.of(context).canPop();

    return Scaffold(
      backgroundColor: colors.authBg,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.s7),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: AppSpace.s3),
              // Only meaningful when pushed from Welcome — the reauth-banner
              // render is the direct root-level phase with nothing to pop to.
              if (canPop)
                IconButton(
                  padding: EdgeInsets.zero,
                  alignment: Alignment.centerLeft,
                  icon: Icon(Icons.arrow_back, color: colors.textPrimary),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              const SizedBox(height: AppSpace.s4),
              Text(widget.reasonBanner != null ? 'Welcome back' : 'Welcome', style: text.screenTitle),
              const SizedBox(height: AppSpace.s2),
              Text('Log in to see your shifts', style: text.bodyMobile.copyWith(color: colors.textSecondary)),
              if (widget.reasonBanner != null) ...[
                const SizedBox(height: AppSpace.s5),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(AppSpace.s4),
                  decoration: BoxDecoration(
                    color: colors.bgSurface,
                    borderRadius: BorderRadius.circular(AppRadius.md),
                    border: Border.all(color: colors.border),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.shield_outlined, size: 18, color: colors.textSecondary),
                      const SizedBox(width: AppSpace.s3),
                      Expanded(
                        child: Text(widget.reasonBanner!, style: text.label.copyWith(color: colors.textSecondary)),
                      ),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: AppSpace.s9),
              _field(context, 'Email', _emailController, hint: 'you@company.com', keyboardType: TextInputType.emailAddress, autofocus: true),
              const SizedBox(height: AppSpace.s5),
              _field(
                context,
                'Password',
                _passwordController,
                hint: 'Password',
                obscure: _obscurePassword,
                trailing: TextButton(
                  style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 0)),
                  onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                  child: Text(
                    _obscurePassword ? 'Show' : 'Hide',
                    style: text.label.copyWith(color: colors.textSecondary, fontWeight: FontWeight.w500),
                  ),
                ),
              ),
              const SizedBox(height: AppSpace.s4),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  style: TextButton.styleFrom(
                    padding: EdgeInsets.zero,
                    minimumSize: const Size(0, 0),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => ForgotPasswordScreen(initialEmail: _emailController.text.trim())),
                  ),
                  child: Text('Forgot password?', style: text.label.copyWith(color: colors.textSecondary, fontWeight: FontWeight.w500)),
                ),
              ),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: AppSpace.s3),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(AppSpace.s3),
                  decoration: BoxDecoration(color: colors.dangerSoft, borderRadius: BorderRadius.circular(AppRadius.sm)),
                  child: Text(_error, style: TextStyle(color: colors.danger, fontSize: 13)),
                ),
              ],
              const SizedBox(height: AppSpace.s6),
              SizedBox(
                width: double.infinity,
                height: 56,
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: colors.gold,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
                  ),
                  onPressed: _canSubmit ? _signIn : null,
                  child: _loading
                      ? SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2, color: colors.textPrimary),
                        )
                      : Text('Log in', style: text.bodyMobile.copyWith(color: colors.textPrimary, fontWeight: FontWeight.w600)),
                ),
              ),
              if (widget.reasonBanner == null) ...[
                const SizedBox(height: AppSpace.s5),
                Center(
                  child: RichText(
                    text: TextSpan(
                      style: text.label.copyWith(color: colors.textPrimary, fontWeight: FontWeight.w500),
                      children: [
                        const TextSpan(text: 'New here?  '),
                        TextSpan(
                          text: 'Create account',
                          recognizer: TapGestureRecognizer()..onTap = _showCreateAccountInfo,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
              const SizedBox(height: AppSpace.s7),
            ],
          ),
        ),
      ),
    );
  }

  Widget _field(
    BuildContext context,
    String label,
    TextEditingController controller, {
    String? hint,
    bool obscure = false,
    bool autofocus = false,
    TextInputType? keyboardType,
    Widget? trailing,
  }) {
    final colors = context.colors;
    final text = context.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: text.label.copyWith(fontWeight: FontWeight.w500)),
        const SizedBox(height: AppSpace.s2),
        Container(
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.s5),
          decoration: BoxDecoration(
            color: colors.bgSurface,
            borderRadius: BorderRadius.circular(AppRadius.lg),
            border: Border.all(color: colors.border),
          ),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: controller,
                  obscureText: obscure,
                  autofocus: autofocus,
                  keyboardType: keyboardType,
                  autocorrect: false,
                  onChanged: (_) => setState(() {}),
                  style: text.bodyMobile.copyWith(fontSize: 16),
                  decoration: InputDecoration(hintText: hint, border: InputBorder.none, isDense: true),
                ),
              ),
              ?trailing,
            ],
          ),
        ),
      ],
    );
  }
}
