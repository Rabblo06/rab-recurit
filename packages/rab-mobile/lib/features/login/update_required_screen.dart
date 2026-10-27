import 'package:flutter/material.dart';

import '../security/security_platform.dart';
import '../security/widgets/security_icon.dart';
import '../security/widgets/security_kit.dart';

/// The only store page the app will open from a server-supplied `updateUrl`
/// (the Android package's Google Play listing, https only). Anything else —
/// another host, scheme, app id or a malformed value — is ignored, so a
/// compromised or misconfigured response can never send the user elsewhere.
Uri? allowlistedUpdateUri(Object? raw) {
  if (raw is! String || raw.length > 512) return null;
  final uri = Uri.tryParse(raw.trim());
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.host != 'play.google.com' ||
      uri.hasPort ||
      uri.userInfo.isNotEmpty ||
      uri.path != '/store/apps/details' ||
      uri.queryParameters['id'] != kAndroidApplicationId) {
    return null;
  }
  return uri;
}

/// `android/app/build.gradle(.kts)` applicationId.
const kAndroidApplicationId = 'com.rab.rab_staff';

/// Design state `update` (M11): the server answered the sign-in with
/// `409 CLIENT_UPDATE_REQUIRED` — this build can't complete a step the account
/// needs. No challenge and no session exist; nothing was stored. The store
/// button appears only for an allowlisted `updateUrl` (none is sent today:
/// then it's the text plus Back, owner decision).
class UpdateRequiredScreen extends StatelessWidget {
  const UpdateRequiredScreen({super.key, this.updateUrl});

  /// The raw `updateUrl` from the 409 body, if any.
  final Object? updateUrl;

  @override
  Widget build(BuildContext context) {
    final store = allowlistedUpdateUri(updateUrl);
    return SecurityPage(
      title: 'Update required',
      body: const [
        SecurityEmblem(SecurityGlyph.phone),
        SecurityHeading(
          title: 'Update to sign in securely',
          body:
              'Your account uses two-factor authentication. Update Crewflow to enter your verification code and continue.',
        ),
        SecurityNotice(
          'Your account and shifts are safe. You’ll be able to sign in once the app is updated.',
        ),
      ],
      actions: [
        if (store != null) ...[
          SecurityButton(
            label: 'Open Google Play',
            onPressed: () => SecurityPlatform.instance.openStore(store),
          ),
          SecurityLink(
            label: 'Back',
            onPressed: () => Navigator.of(context).maybePop(),
          ),
        ] else
          SecurityButton(
            label: 'Back',
            kind: SecurityButtonKind.secondary,
            onPressed: () => Navigator.of(context).maybePop(),
          ),
      ],
    );
  }
}
