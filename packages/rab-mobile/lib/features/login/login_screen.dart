import 'dart:io';

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

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;

    return Scaffold(
      backgroundColor: colors.bgApp,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpace.s7),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 380),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 56,
                    height: 56,
                    decoration: BoxDecoration(
                      color: colors.accent,
                      borderRadius: BorderRadius.circular(AppRadius.lg),
                    ),
                    alignment: Alignment.center,
                    child: const Text('R', style: TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w700)),
                  ),
                  const SizedBox(height: AppSpace.s4),
                  Text('rab', style: text.screenTitle),
                  const SizedBox(height: AppSpace.s2),
                  Text('Sign in to see your shifts', style: text.bodyMobile.copyWith(color: colors.textSecondary)),
                  if (widget.reasonBanner != null) ...[
                    const SizedBox(height: AppSpace.s5),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(AppSpace.s4),
                      decoration: BoxDecoration(
                        color: colors.bgSubtle,
                        borderRadius: BorderRadius.circular(AppRadius.sm),
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
                  const SizedBox(height: AppSpace.s8),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(AppSpace.s6),
                    decoration: BoxDecoration(
                      color: colors.bgSurface,
                      borderRadius: BorderRadius.circular(AppRadius.lg),
                      border: Border.all(color: colors.border),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _field(context, 'Email', _emailController, hint: 'you@company.com', keyboardType: TextInputType.emailAddress, autofocus: true),
                        const SizedBox(height: AppSpace.s4),
                        _field(context, 'Password', _passwordController, hint: 'Password', obscure: true),
                        const SizedBox(height: AppSpace.s3),
                        Align(
                          alignment: Alignment.centerRight,
                          child: TextButton(
                            style: TextButton.styleFrom(
                              padding: EdgeInsets.zero,
                              minimumSize: const Size(0, 0),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            onPressed: () => Navigator.of(context).push(
                              MaterialPageRoute(builder: (_) => ForgotPasswordScreen(initialEmail: _emailController.text.trim())),
                            ),
                            child: Text(
                              'Forgot password?',
                              style: TextStyle(color: colors.textTertiary, fontSize: 13),
                            ),
                          ),
                        ),
                        if (_error.isNotEmpty) ...[
                          const SizedBox(height: AppSpace.s3),
                          Container(
                            padding: const EdgeInsets.all(AppSpace.s3),
                            decoration: BoxDecoration(
                              color: colors.dangerSoft,
                              borderRadius: BorderRadius.circular(AppRadius.sm),
                            ),
                            child: Text(_error, style: TextStyle(color: colors.danger, fontSize: 13)),
                          ),
                        ],
                        const SizedBox(height: AppSpace.s6),
                        SizedBox(
                          height: 48,
                          child: FilledButton(
                            style: FilledButton.styleFrom(
                              backgroundColor: colors.accent,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
                            ),
                            onPressed: _canSubmit ? _signIn : null,
                            child: _loading
                                ? const SizedBox(
                                    width: 20,
                                    height: 20,
                                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                  )
                                : const Text('Sign in', style: TextStyle(fontWeight: FontWeight.w600)),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
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
  }) {
    final colors = context.colors;
    final text = context.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: text.label),
        const SizedBox(height: AppSpace.s2),
        TextField(
          controller: controller,
          obscureText: obscure,
          autofocus: autofocus,
          keyboardType: keyboardType,
          autocorrect: false,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            hintText: hint,
            filled: true,
            fillColor: colors.bgApp,
            contentPadding: const EdgeInsets.symmetric(horizontal: AppSpace.s4, vertical: AppSpace.s4),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppRadius.sm),
              borderSide: BorderSide(color: colors.border),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppRadius.sm),
              borderSide: BorderSide(color: colors.border),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppRadius.sm),
              borderSide: BorderSide(color: colors.accent),
            ),
          ),
        ),
      ],
    );
  }
}
