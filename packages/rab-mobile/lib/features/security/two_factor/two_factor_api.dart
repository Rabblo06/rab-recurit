import '../../../core/api/api_client.dart';
import '../security_tokens.dart';

/// `GET /auth/mfa` (account security step 1, `MfaManagementService.status`).
/// Every value the screens show comes from here; nothing is counted or
/// assumed on the client.
class TwoFactorStatus {
  const TwoFactorStatus({
    required this.enabled,
    required this.enabledAt,
    required this.recoveryCodesRemaining,
    required this.recoveryCodesTotal,
    required this.enforced,
    required this.enrolmentAvailable,
    required this.hasPassword,
    required this.linkedProviders,
    required this.ssoReauthProviders,
  });

  final bool enabled;
  final DateTime? enabledAt;
  final int recoveryCodesRemaining;

  /// Size of a full set (10 while on, 0 while off). Never hard-coded here.
  final int recoveryCodesTotal;

  /// An enforcement flag applies: turning 2FA off is refused by the server.
  final bool enforced;

  /// New enrolments are allowed by this deployment.
  final bool enrolmentAvailable;

  /// False for a Google/Microsoft-only account: no password field is shown.
  final bool hasPassword;
  final List<String> linkedProviders;
  final List<String> ssoReauthProviders;

  bool get lowRecoveryCodes =>
      enabled && recoveryCodesRemaining <= SecurityTokens.lowRecoveryCodes;

  factory TwoFactorStatus.fromJson(Map<String, dynamic> json) {
    List<String> strings(Object? value) =>
        value is List ? value.whereType<String>().toList() : const [];
    int count(Object? value) => value is num ? value.toInt() : 0;
    return TwoFactorStatus(
      enabled: json['enabled'] == true,
      enabledAt: json['enabledAt'] is String
          ? DateTime.tryParse(json['enabledAt'] as String)
          : null,
      recoveryCodesRemaining: count(json['recoveryCodesRemaining']),
      recoveryCodesTotal: count(json['recoveryCodesTotal']),
      enforced: json['enforced'] == true,
      enrolmentAvailable: json['enrolmentAvailable'] == true,
      // Missing → ask for the password; the server decides either way.
      hasPassword: json['hasPassword'] != false,
      linkedProviders: strings(json['linkedProviders']),
      ssoReauthProviders: strings(json['ssoReauthProviders']),
    );
  }
}

/// `POST /auth/mfa/enrolment` → the provisioning material. Mobile shows no QR
/// (owner decision): the `otpauth://` URI is handed to an authenticator on this
/// phone and the manual key is the fallback. Held in memory by the setup
/// screen only; never stored or logged.
class EnrolmentMaterial {
  const EnrolmentMaterial({required this.otpauthUri, required this.manualKey});
  final String otpauthUri;
  final String manualKey;

  factory EnrolmentMaterial.fromJson(Map<String, dynamic> json) =>
      EnrolmentMaterial(
        otpauthUri: json['otpauthUri'] as String? ?? '',
        manualKey: json['manualKey'] as String? ?? '',
      );

  /// The account label inside the URI (`otpauth://totp/Issuer:account?...`),
  /// i.e. what the authenticator will list. Null when it can't be read.
  String? get accountName {
    final uri = Uri.tryParse(otpauthUri);
    if (uri == null || uri.pathSegments.isEmpty) return null;
    final label = Uri.decodeComponent(uri.pathSegments.last);
    final colon = label.indexOf(':');
    final account = (colon >= 0 ? label.substring(colon + 1) : label).trim();
    return account.isEmpty ? null : account;
  }

  /// The setup key as an authenticator expects it (no grouping spaces).
  String get compactKey => manualKey.replaceAll(RegExp(r'\s+'), '');
}

/// The signed-in user's own second factor (`MfaController`, reachable from
/// both mobile apps since step 1). Transport only: every rule is the server's.
class TwoFactorApi {
  TwoFactorApi(this._api);
  final ApiClient _api;

  Future<TwoFactorStatus> status() async => TwoFactorStatus.fromJson(
    await _api.get('/auth/mfa') as Map<String, dynamic>,
  );

  /// Identity proof: [currentPassword], or — for an account with no password
  /// — none, and the server checks for a fresh grant of this session.
  Future<EnrolmentMaterial> startEnrolment({String? currentPassword}) async =>
      EnrolmentMaterial.fromJson(
        await _api.post(
              '/auth/mfa/enrolment',
              body: {'currentPassword': ?currentPassword},
            )
            as Map<String, dynamic>,
      );

  /// The first code from the authenticator → the ten recovery codes, shown once.
  Future<List<String>> confirmEnrolment(String code) async => _codes(
    await _api.post('/auth/mfa/enrolment/confirm', body: {'code': code}),
  );

  Future<List<String>> regenerateRecoveryCodes({
    String? currentPassword,
    required String code,
  }) async => _codes(
    await _api.post(
      '/auth/mfa/recovery-codes',
      body: {'currentPassword': ?currentPassword, 'code': code},
    ),
  );

  /// 204 on success. [code] is a current TOTP or one recovery code.
  Future<void> disable({String? currentPassword, required String code}) async {
    await _api.post(
      '/auth/mfa/disable',
      body: {'currentPassword': ?currentPassword, 'code': code},
    );
  }

  static List<String> _codes(Object? body) {
    final codes = body is Map ? body['recoveryCodes'] : null;
    if (codes is! List || codes.isEmpty) {
      throw ApiException(502, 'Something went wrong. Please try again.');
    }
    return codes.whereType<String>().toList();
  }
}

enum TwoFactorFailureField { none, password, code }

/// A refusal from a two-factor management route, mapped to what the screen
/// shows and which input it belongs to. The messages are the server's stable
/// codes turned into the design's wording; nothing is guessed.
class TwoFactorFailure {
  const TwoFactorFailure(
    this.message, {
    this.field = TwoFactorFailureField.none,
  });
  final String message;
  final TwoFactorFailureField field;

  static const wrongPassword =
      'That password didn’t work. Check it and try again.';
  static const wrongCode =
      'That code didn’t work. Check your authenticator app and try again.';

  /// Microsoft re-authentication exists only on the web console (TO-3/P6),
  /// so a no-password account can prove itself here only with the fresh
  /// sign-in grant the server accepts shortly after signing in.
  static const webOnlyProof =
      'Your account signs in with Google or Microsoft, so confirming it’s you '
      'happens on the Crewflow web console. Make this change there, or try '
      'again here right after signing in.';

  static TwoFactorFailure from(Object error, {required bool hasPassword}) {
    if (error is ApiException) {
      final code = error.code;
      switch (code) {
        case 'STEP_UP_MFA_INVALID':
        case 'MFA_CODE_INVALID':
          return const TwoFactorFailure(
            wrongCode,
            field: TwoFactorFailureField.code,
          );
        case 'STEP_UP_REQUIRED':
          return hasPassword
              ? const TwoFactorFailure(
                  'Enter your current password to continue.',
                  field: TwoFactorFailureField.password,
                )
              : const TwoFactorFailure(webOnlyProof);
        case 'MFA_ENROLMENT_DISABLED':
        case 'MFA_REQUIRED_BY_POLICY':
        case 'MFA_ALREADY_ENABLED':
        case 'MFA_NOT_ENABLED':
          return TwoFactorFailure(error.userMessage);
      }
      // The password refusal is a plain 403 with no code (StepUpReauthService).
      if (error.statusCode == 403 && code == null && hasPassword) {
        return const TwoFactorFailure(
          wrongPassword,
          field: TwoFactorFailureField.password,
        );
      }
      return TwoFactorFailure(error.userMessage);
    }
    // Offline, TLS and timeout failures read as "Connection lost…".
    return TwoFactorFailure(userMessageFor(error));
  }
}
