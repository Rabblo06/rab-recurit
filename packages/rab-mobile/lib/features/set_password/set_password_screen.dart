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
  bool _obscureNew = true;
  bool _obscureConfirm = true;

  static final _hasNumberOrSymbol = RegExp(r'[0-9\W]');

  @override
  void dispose() {
    _passwordController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  bool get _mismatch => _confirmController.text.isNotEmpty && _passwordController.text != _confirmController.text;
  bool get _hasLength => _passwordController.text.length >= 10;
  bool get _hasNumberOrSymbolCheck => _hasNumberOrSymbol.hasMatch(_passwordController.text);

  bool get _canSubmit => _hasLength && !_mismatch && !_loading;

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
      backgroundColor: colors.authBg,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.s7),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: AppSpace.s9),
              Text('Set a new password', style: text.screenTitle),
              const SizedBox(height: AppSpace.s3),
              Text(
                'Your temporary password has expired. Choose a new one to continue.',
                style: text.bodyMobile.copyWith(color: colors.textSecondary),
              ),
              const SizedBox(height: AppSpace.s9),
              _field(
                context,
                'New password',
                _passwordController,
                obscure: _obscureNew,
                autofocus: true,
                onToggle: () => setState(() => _obscureNew = !_obscureNew),
              ),
              const SizedBox(height: AppSpace.s5),
              _field(
                context,
                'Confirm password',
                _confirmController,
                obscure: _obscureConfirm,
                onToggle: () => setState(() => _obscureConfirm = !_obscureConfirm),
              ),
              if (_mismatch) ...[
                const SizedBox(height: AppSpace.s2),
                Text("Passwords don't match.", style: TextStyle(color: colors.danger, fontSize: 12)),
              ],
              const SizedBox(height: AppSpace.s5),
              _checklistRow(context, 'At least 10 characters', _hasLength),
              const SizedBox(height: AppSpace.s2),
              _checklistRow(context, 'One number or symbol', _hasNumberOrSymbolCheck),
              const SizedBox(height: AppSpace.s2),
              // Only the server can verify this against real password
              // history — shown as a static reminder, not a live check.
              _checklistRow(context, 'Not a password you have used before', null),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: AppSpace.s4),
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
                  onPressed: _canSubmit ? _submit : null,
                  child: _loading
                      ? SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: colors.textPrimary))
                      : Text('Save and continue', style: text.bodyMobile.copyWith(color: colors.textPrimary, fontWeight: FontWeight.w600)),
                ),
              ),
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
    required bool obscure,
    required VoidCallback onToggle,
    bool autofocus = false,
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
                  autocorrect: false,
                  onChanged: (_) => setState(() {}),
                  style: text.bodyMobile.copyWith(fontSize: 16),
                  decoration: const InputDecoration(border: InputBorder.none, isDense: true),
                ),
              ),
              TextButton(
                style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 0)),
                onPressed: onToggle,
                child: Text(obscure ? 'Show' : 'Hide', style: text.label.copyWith(color: colors.textSecondary, fontWeight: FontWeight.w500)),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// [met] is null for the one rule that can't be checked client-side —
  /// rendered as a neutral, always-gold dot rather than faking a pass/fail.
  Widget _checklistRow(BuildContext context, String label, bool? met) {
    final colors = context.colors;
    final text = context.text;
    final dotColor = met == null ? colors.gold : (met ? colors.accent : colors.gold);
    return Row(
      children: [
        Container(width: 6, height: 6, decoration: BoxDecoration(shape: BoxShape.circle, color: dotColor)),
        const SizedBox(width: AppSpace.s3),
        Text(label, style: text.label.copyWith(color: colors.textSecondary)),
      ],
    );
  }
}
