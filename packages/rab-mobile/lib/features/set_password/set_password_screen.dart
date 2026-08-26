import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/tokens.dart';

/// Shown by `_RootGate` (see app.dart) whenever `user.mustResetPassword` is
/// true — reached either right after signing in with a temporary password,
/// or after an admin-triggered reset. The server's `MustResetPasswordGuard`
/// is the real control (every other route 403s until this completes); this
/// screen is just the UX for it, mirroring the web SetPassword screen.
class SetPasswordScreen extends StatefulWidget {
  const SetPasswordScreen({super.key});

  @override
  State<SetPasswordScreen> createState() => _SetPasswordScreenState();
}

class _SetPasswordScreenState extends State<SetPasswordScreen> {
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();
  String _error = '';
  bool _loading = false;

  @override
  void dispose() {
    _passwordController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  bool get _mismatch => _confirmController.text.isNotEmpty && _passwordController.text != _confirmController.text;

  bool get _canSubmit =>
      _passwordController.text.length >= 10 && !_mismatch && !_loading;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() {
      _error = '';
      _loading = true;
    });
    try {
      await context.read<AuthProvider>().setPassword(_passwordController.text);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
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
                  Text('Create your new password', style: text.pageTitle, textAlign: TextAlign.center),
                  const SizedBox(height: AppSpace.s2),
                  Text(
                    'For your security, you need to set a new password before continuing.',
                    style: text.bodyMobile,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: AppSpace.s7),
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
                        _field(context, 'New password', _passwordController, autofocus: true),
                        const SizedBox(height: AppSpace.s4),
                        _field(context, 'Confirm password', _confirmController),
                        if (_mismatch) ...[
                          const SizedBox(height: AppSpace.s2),
                          Text("Passwords don't match.", style: TextStyle(color: colors.danger, fontSize: 12)),
                        ],
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
                            onPressed: _canSubmit ? _submit : null,
                            child: _loading
                                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                                : const Text('Update password', style: TextStyle(fontWeight: FontWeight.w600)),
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

  Widget _field(BuildContext context, String label, TextEditingController controller, {bool autofocus = false}) {
    final colors = context.colors;
    final text = context.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: text.label),
        const SizedBox(height: AppSpace.s2),
        TextField(
          controller: controller,
          obscureText: true,
          autofocus: autofocus,
          autocorrect: false,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            hintText: label,
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
