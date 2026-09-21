import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/rab_auth_sheet.dart';

/// Set Password's sheet content — identical validation/submit logic to the
/// old standalone screen (`AuthProvider.setPassword`, same real password
/// rules, same honest "can't verify client-side" third checklist item);
/// only the presentation moved into the shared `AuthSheet`.
class SetPasswordSheetContent extends StatefulWidget {
  const SetPasswordSheetContent({super.key, required this.reveal});

  final double reveal;

  @override
  State<SetPasswordSheetContent> createState() =>
      _SetPasswordSheetContentState();
}

class _SetPasswordSheetContentState extends State<SetPasswordSheetContent> {
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();
  String _error = '';
  bool _loading = false;
  bool _done = false;
  bool _obscureNew = true;
  bool _obscureConfirm = true;

  static final _hasNumberOrSymbol = RegExp(r'[0-9\W]');

  @override
  void dispose() {
    _passwordController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  bool get _mismatch =>
      _confirmController.text.isNotEmpty &&
      _passwordController.text != _confirmController.text;
  bool get _hasLength => _passwordController.text.length >= 10;
  bool get _hasNumberOrSymbolCheck =>
      _hasNumberOrSymbol.hasMatch(_passwordController.text);
  bool get _canSubmit => _hasLength && !_mismatch && !_loading;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() {
      _error = '';
      _loading = true;
    });
    try {
      await context.read<AuthProvider>().setPassword(_passwordController.text);
      if (mounted) setState(() => _done = true);
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

    if (_done) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 32),
        child: Column(
          children: [
            const Icon(
              Icons.check_circle_outline,
              color: Color(0xFF0F5C3F),
              size: 40,
            ),
            const SizedBox(height: 20),
            Text(
              'Password updated successfully',
              textAlign: TextAlign.center,
              style: text.pageTitle,
            ),
            const SizedBox(height: 16),
            InkWell(
              onTap: () => context.read<AuthProvider>().logout(),
              child: const Padding(
                padding: EdgeInsets.all(12),
                child: Text(
                  'Go back to login',
                  style: TextStyle(
                    color: Color(0xFF0F5C3F),
                    decoration: TextDecoration.underline,
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }

    return StaggeredReveal(
      progress: widget.reveal,
      children: [
        Text(
          'Set secure password',
          style: text.pageTitle.copyWith(fontSize: 24),
        ),
        _field(
          context,
          'CREATE PASSWORD',
          _passwordController,
          obscure: _obscureNew,
          onToggle: () => setState(() => _obscureNew = !_obscureNew),
        ),
        _field(
          context,
          'CONFIRM PASSWORD',
          _confirmController,
          obscure: _obscureConfirm,
          onToggle: () => setState(() => _obscureConfirm = !_obscureConfirm),
        ),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_mismatch) ...[
              Text(
                "Passwords don't match.",
                style: TextStyle(color: colors.danger, fontSize: 12),
              ),
              const SizedBox(height: AppSpace.s3),
            ],
            Text(
              'SECURITY REQUIREMENTS',
              style: text.microLabel.copyWith(color: colors.textTertiary),
            ),
            const SizedBox(height: AppSpace.s3),
            _checklistRow(context, '10 or more characters', _hasLength),
            const SizedBox(height: AppSpace.s2),
            _checklistRow(
              context,
              'At least one number or symbol',
              _hasNumberOrSymbolCheck,
            ),
            const SizedBox(height: AppSpace.s2),
            _checklistRow(context, 'Not a password you have used before', null),
          ],
        ),
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
              const SizedBox(height: AppSpace.s4),
            ],
            SizedBox(
              width: double.infinity,
              height: 56,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accentStrong,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(AppRadius.full),
                  ),
                ),
                onPressed: _canSubmit ? _submit : null,
                child: _loading
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : Text(
                        'Continue to Biometric Setup',
                        style: text.bodyMobile.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _field(
    BuildContext context,
    String label,
    TextEditingController controller, {
    required bool obscure,
    required VoidCallback onToggle,
  }) {
    final colors = context.colors;
    final text = context.text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: text.microLabel.copyWith(color: colors.textTertiary),
        ),
        const SizedBox(height: AppSpace.s2),
        Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.s5),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.lg),
            border: Border.all(color: colors.border),
          ),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: controller,
                  obscureText: obscure,
                  autocorrect: false,
                  onChanged: (_) => setState(() {}),
                  style: text.bodyMobile.copyWith(fontSize: 15),
                  decoration: const InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                  ),
                ),
              ),
              TextButton(
                style: TextButton.styleFrom(
                  padding: EdgeInsets.zero,
                  minimumSize: const Size(0, 0),
                ),
                onPressed: onToggle,
                child: Text(
                  obscure ? 'Show' : 'Hide',
                  style: text.label.copyWith(fontWeight: FontWeight.w500),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _checklistRow(BuildContext context, String label, bool? met) {
    final colors = context.colors;
    final text = context.text;
    final color = met == null
        ? colors.textTertiary
        : (met ? colors.accent : colors.textTertiary);
    return Row(
      children: [
        Icon(
          met == true ? Icons.check_circle : Icons.circle_outlined,
          size: 14,
          color: color,
        ),
        const SizedBox(width: AppSpace.s3),
        Text(label, style: text.label),
      ],
    );
  }
}
