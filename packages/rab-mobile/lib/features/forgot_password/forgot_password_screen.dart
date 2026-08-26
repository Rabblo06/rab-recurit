import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/theme/tokens.dart';

/// Self-service "forgot password" — only ever asks for email, matching the
/// web console's `/forgot-password`. The actual reset link is completed on
/// the web (opened from the emailed link in the device's browser), not
/// deep-linked back into this app — that would need app-links/universal-links
/// platform wiring this build doesn't have yet.
class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({super.key, this.initialEmail = ''});

  final String initialEmail;

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  late final _emailController = TextEditingController(text: widget.initialEmail);
  bool _loading = false;
  bool _sent = false;

  @override
  void dispose() {
    _emailController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final email = _emailController.text.trim();
    if (email.isEmpty) return;
    setState(() => _loading = true);
    try {
      // Always the same outcome whether or not the account exists — no
      // enumeration (mirrors AuthService.forgotPassword server-side).
      await context.read<AuthProvider>().forgotPassword(email);
    } catch (_) {
      // Still show the generic confirmation — a network error here must not
      // reveal anything different from "we sent it if it exists".
    } finally {
      if (mounted) setState(() { _loading = false; _sent = true; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.colors.bgApp,
      appBar: AppBar(title: const Text('Reset password')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpace.s7),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 380),
              child: _sent ? _sentView(context) : _formView(context),
            ),
          ),
        ),
      ),
    );
  }

  Widget _sentView(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Check your email', style: text.pageTitle, textAlign: TextAlign.center),
        const SizedBox(height: AppSpace.s3),
        Text(
          "If an account exists for ${_emailController.text.trim()}, you'll receive an email with a link to reset your password shortly.",
          style: text.bodyMobile.copyWith(color: colors.textSecondary),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: AppSpace.s7),
        SizedBox(
          height: 48,
          child: FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: colors.accent,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
            ),
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Return to sign in', style: TextStyle(fontWeight: FontWeight.w600)),
          ),
        ),
      ],
    );
  }

  Widget _formView(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    return Container(
      padding: const EdgeInsets.all(AppSpace.s6),
      decoration: BoxDecoration(
        color: colors.bgSurface,
        borderRadius: BorderRadius.circular(AppRadius.lg),
        border: Border.all(color: colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text("Enter your email and we'll send you a reset link.", style: text.bodyMobile),
          const SizedBox(height: AppSpace.s5),
          Text('Email', style: text.label),
          const SizedBox(height: AppSpace.s2),
          TextField(
            controller: _emailController,
            autofocus: true,
            keyboardType: TextInputType.emailAddress,
            autocorrect: false,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              hintText: 'you@company.com',
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
          const SizedBox(height: AppSpace.s6),
          SizedBox(
            height: 48,
            child: FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: colors.accent,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
              ),
              onPressed: (_emailController.text.trim().isNotEmpty && !_loading) ? _submit : null,
              child: _loading
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Send reset link', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }
}
