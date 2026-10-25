import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/auth/biometric_authenticator.dart';
import '../../core/auth/biometric_label.dart';
import '../forgot_password/forgot_password_screen.dart';
import '../security/security_tokens.dart';
import '../security/two_factor/change_two_factor_screens.dart';
import '../security/two_factor/enrolment_screens.dart';
import '../security/two_factor/two_factor_api.dart';
import '../security/widgets/security_icon.dart';
import '../security/widgets/security_kit.dart';

/// Profile > Security (design states `off`, `on`, `low`): the account, the
/// two-factor card (status from `GET /auth/mfa`, never assumed), the real
/// biometric switch (this device's own label, no "Face ID" on Android) and
/// "Change password" (the existing email reset flow). Light, like Profile.
class SecurityScreen extends StatefulWidget {
  const SecurityScreen({super.key, this.api});

  /// Injected in tests; production builds it from [AuthProvider.api].
  final TwoFactorApi? api;

  static const routeName = kSecurityRouteName;

  /// The named route, so the setup flow can return here with [popToSecurityHome].
  static Route<void> route() => MaterialPageRoute<void>(
    settings: const RouteSettings(name: routeName),
    builder: (_) => const SecurityScreen(),
  );

  @override
  State<SecurityScreen> createState() => _SecurityScreenState();
}

class _SecurityScreenState extends State<SecurityScreen> {
  late final TwoFactorApi _api =
      widget.api ?? TwoFactorApi(context.read<AuthProvider>().api);
  late Future<BiometricCapability> _capabilityFuture;
  TwoFactorStatus? _status;
  String? _loadError;
  bool _loading = true;
  bool _biometricBusy = false;

  @override
  void initState() {
    super.initState();
    _capabilityFuture = context.read<AuthProvider>().checkBiometricCapability();
    _load();
  }

  Future<void> _load({bool announceChange = false}) async {
    final before = _status?.enabled;
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final status = await _api.status();
      if (!mounted) return;
      setState(() {
        _status = status;
        _loading = false;
      });
      // Feedback only once the SERVER reports the new state.
      if (announceChange && before != null && before != status.enabled) {
        showSecuritySnack(
          context,
          status.enabled
              ? 'Two-factor authentication is on.'
              : 'Two-factor authentication is off.',
        );
      }
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadError = TwoFactorFailure.from(error, hasPassword: true).message;
      });
    }
  }

  Future<void> _open(Widget page) async {
    await Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => page));
    if (mounted) await _load(announceChange: true);
  }

  Future<void> _toggleBiometric(bool value) async {
    setState(() => _biometricBusy = true);
    final auth = context.read<AuthProvider>();
    if (value) {
      await auth.enableBiometric();
    } else {
      await auth.disableBiometric();
    }
    if (mounted) setState(() => _biometricBusy = false);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthProvider>();
    final user = auth.user;
    final status = _status;
    return SecurityPage(
      title: 'Security',
      body: [
        if (user != null)
          _AccountHeader(
            name: user.fullName.trim(),
            email: user.email,
            initials: _initials(user.firstName, user.lastName, user.email),
          ),
        _TwoFactorCard(
          status: status,
          loading: _loading && status == null,
          error: status == null ? _loadError : null,
          onRetry: _load,
          onTurnOn: status == null
              ? null
              : () => _open(
                  ConfirmIdentityScreen(
                    api: _api,
                    hasPassword: status.hasPassword,
                  ),
                ),
          onRegenerate: status == null
              ? null
              : () => _open(
                  RegenerateCodesScreen(
                    api: _api,
                    hasPassword: status.hasPassword,
                  ),
                ),
          onTurnOff: status == null
              ? null
              : () => _open(
                  TurnOffTwoFactorScreen(
                    api: _api,
                    hasPassword: status.hasPassword,
                  ),
                ),
        ),
        FutureBuilder<BiometricCapability>(
          future: _capabilityFuture,
          builder: (context, snapshot) {
            final capability = snapshot.data;
            final rows = <Widget>[
              if (capability != null && capability.isAvailable)
                _SettingRow(
                  label: biometricLabel(
                    capability.enrolledTypes,
                    isIOS: isIOSPlatform,
                  ),
                  trailing: Switch(
                    value: auth.biometricEnabledForCurrentUser,
                    onChanged: _biometricBusy ? null : _toggleBiometric,
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    activeTrackColor: SecurityTokens.pill,
                  ),
                ),
              if (status?.hasPassword != false && user != null)
                _SettingRow(
                  label: 'Change password',
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          ForgotPasswordScreen(initialEmail: user.email),
                    ),
                  ),
                  trailing: const SecurityIcon(
                    SecurityGlyph.chevron,
                    size: 16,
                    color: SecurityTokens.ink,
                  ),
                ),
            ];
            if (rows.isEmpty) return const SizedBox.shrink();
            return SecurityCard(
              gap: 0,
              children: [
                for (var i = 0; i < rows.length; i++)
                  _RowFrame(
                    first: i == 0,
                    last: i == rows.length - 1,
                    child: rows[i],
                  ),
              ],
            );
          },
        ),
        const SecurityCaption(
          'Two-factor authentication is optional.\nOnce enabled, it’s required at every sign-in.',
        ),
      ],
    );
  }

  static String _initials(String first, String last, String email) {
    String letter(String value) =>
        value.trim().isEmpty ? '' : value.trim().characters.first;
    final initials = '${letter(first)}${letter(last)}'.toUpperCase();
    return initials.isNotEmpty ? initials : letter(email).toUpperCase();
  }
}

class _AccountHeader extends StatelessWidget {
  const _AccountHeader({
    required this.name,
    required this.email,
    required this.initials,
  });
  final String name;
  final String email;
  final String initials;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      ExcludeSemantics(
        child: Container(
          width: 46,
          height: 46,
          alignment: Alignment.center,
          decoration: const BoxDecoration(
            color: SecurityTokens.avatarFill,
            shape: BoxShape.circle,
          ),
          child: Text(
            initials,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: SecurityTokens.avatarText,
            ),
          ),
        ),
      ),
      const SizedBox(width: 12),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (name.isNotEmpty)
              Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: SecurityType.h3,
              ),
            Text(
              email,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: SecurityType.tiny,
            ),
          ],
        ),
      ),
    ],
  );
}

/// The two-factor card. Every number is the server's.
class _TwoFactorCard extends StatelessWidget {
  const _TwoFactorCard({
    required this.status,
    required this.loading,
    required this.error,
    required this.onRetry,
    required this.onTurnOn,
    required this.onRegenerate,
    required this.onTurnOff,
  });

  final TwoFactorStatus? status;
  final bool loading;
  final String? error;
  final VoidCallback onRetry;
  final VoidCallback? onTurnOn;
  final VoidCallback? onRegenerate;
  final VoidCallback? onTurnOff;

  @override
  Widget build(BuildContext context) {
    final status = this.status;
    final on = status?.enabled == true;
    const cardBody = TextStyle(
      fontSize: 12,
      height: 1.8,
      color: SecurityTokens.muted,
    );
    return SecurityCard(
      children: [
        Row(
          children: [
            const SecurityEmblem(SecurityGlyph.shield),
            const Spacer(),
            if (status != null) SecurityBadge(on: on),
          ],
        ),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              header: true,
              child: const Text(
                'Two-factor authentication',
                style: SecurityType.h2,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              on
                  ? 'Enter a code from your authenticator app each time you sign in on web or mobile.'
                  : 'Add an extra layer of protection with a code from your authenticator app.',
              style: cardBody,
            ),
          ],
        ),
        if (loading)
          const Center(
            child: SizedBox.square(
              dimension: 24,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: SecurityTokens.ink,
              ),
            ),
          )
        else if (error != null) ...[
          SecurityNotice(error!, kind: SecurityNoticeKind.error),
          SecurityButton(
            label: 'Try again',
            kind: SecurityButtonKind.secondary,
            onPressed: onRetry,
          ),
        ] else if (status != null && on) ...[
          if (status.lowRecoveryCodes)
            SecurityNotice(
              _lowCodesMessage(status.recoveryCodesRemaining),
              kind: SecurityNoticeKind.warning,
            ),
          _DetailsRow(
            label: 'Recovery codes',
            value: status.recoveryCodesTotal > 0
                ? '${status.recoveryCodesRemaining} of ${status.recoveryCodesTotal} left'
                : '${status.recoveryCodesRemaining} left',
          ),
          if (status.enforced) ...[
            SecurityButton(
              label: 'Get new recovery codes',
              kind: SecurityButtonKind.secondary,
              onPressed: onRegenerate,
            ),
            const SecurityNotice(
              'Two-factor authentication is required for your account, so it can’t be turned off.',
            ),
          ] else
            // One section: the link's 48px hit area already holds the gap.
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SecurityButton(
                  label: 'Get new recovery codes',
                  kind: SecurityButtonKind.secondary,
                  onPressed: onRegenerate,
                ),
                const SizedBox(height: 4),
                SecurityLink(label: 'Turn off 2FA', onPressed: onTurnOff),
              ],
            ),
        ] else if (status != null) ...[
          if (!status.enrolmentAvailable)
            const SecurityNotice('Two-factor setup isn’t available right now.'),
          SecurityButton(
            label: 'Turn on 2FA',
            onPressed: status.enrolmentAvailable ? onTurnOn : null,
          ),
        ],
      ],
    );
  }

  static String _lowCodesMessage(int remaining) => switch (remaining) {
    0 =>
      'No recovery codes left. Save a new set to keep access to your account.',
    1 =>
      'Only 1 recovery code left. Save a new set to keep access to your account.',
    _ =>
      'Only $remaining recovery codes left. Save a new set to keep access to your account.',
  };
}

/// `.details-row`: top rule, muted label, bold value.
class _DetailsRow extends StatelessWidget {
  const _DetailsRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => MergeSemantics(
    child: Container(
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: SecurityTokens.line)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 12,
                height: 1.5,
                color: SecurityTokens.muted,
              ),
            ),
          ),
          Text(
            value,
            style: const TextStyle(
              fontSize: 12,
              height: 1.5,
              fontWeight: FontWeight.w600,
              color: SecurityTokens.ink,
            ),
          ),
        ],
      ),
    ),
  );
}

/// `.mobile-security-row` content: 12px label + trailing control.
class _SettingRow extends StatelessWidget {
  const _SettingRow({required this.label, required this.trailing, this.onTap});
  final String label;
  final Widget trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final row = Row(
      children: [
        Expanded(child: Text(label, style: SecurityType.small)),
        trailing,
      ],
    );
    if (onTap == null) return MergeSemantics(child: row);
    return Semantics(
      button: true,
      child: InkWell(onTap: onTap, child: row),
    );
  }
}

/// `.mobile-security-row` frame: 15px vertical padding, a rule between rows,
/// none above the first or below the last; at least a 48px row.
class _RowFrame extends StatelessWidget {
  const _RowFrame({
    required this.first,
    required this.last,
    required this.child,
  });
  final bool first;
  final bool last;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minHeight: 48),
    padding: EdgeInsets.only(top: first ? 0 : 8, bottom: last ? 0 : 8),
    decoration: BoxDecoration(
      border: last
          ? null
          : const Border(bottom: BorderSide(color: SecurityTokens.line)),
    ),
    alignment: Alignment.centerLeft,
    child: child,
  );
}
