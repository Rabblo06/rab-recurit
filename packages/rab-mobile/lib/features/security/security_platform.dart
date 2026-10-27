import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

/// The few platform calls the security screens make. Nothing here logs,
/// stores or reports what it handles (setup keys, otpauth URIs and recovery
/// codes pass straight through to the OS). Replaceable in tests.
class SecurityPlatform {
  /// The production implementation; tests assign a fake.
  static SecurityPlatform instance = SecurityPlatform();

  static const channel = MethodChannel('rab/secure_window');

  bool get _android =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  /// Android `FLAG_SECURE` on the app window: blocks screenshots, screen
  /// recording and the Recents thumbnail. Best effort (no channel → no-op).
  Future<void> setSecureWindow(bool secure) async {
    if (!_android) return;
    try {
      await channel.invokeMethod<void>('setSecure', {'secure': secure});
    } on PlatformException {
      // Fail soft: the screen still works; the flag is an extra layer.
    } on MissingPluginException {
      // Same.
    }
  }

  /// Copies [text]. On Android 13+ the clip is marked sensitive, so the
  /// system clipboard preview does not show it.
  Future<void> copySensitive(String text) async {
    if (_android) {
      try {
        final done = await channel.invokeMethod<bool>('copySensitive', {
          'text': text,
        });
        if (done == true) return;
      } on PlatformException {
        // Fall through to the plain clipboard.
      } on MissingPluginException {
        // Same.
      }
    }
    await Clipboard.setData(ClipboardData(text: text));
  }

  /// Hands an `otpauth://` URI to an authenticator app on this phone. False
  /// when nothing handled it (the screen then points at the setup key).
  Future<bool> openAuthenticator(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      return false;
    }
  }

  /// Opens an allowlisted store page (see `allowlistedUpdateUri`).
  Future<bool> openStore(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      return false;
    }
  }

  /// The system share sheet ("Share or save codes").
  Future<void> shareText(String text, {String? subject}) async {
    await SharePlus.instance.share(ShareParams(text: text, subject: subject));
  }
}

/// Reference-counted `FLAG_SECURE`: on while at least one [SecureWindow]
/// widget is mounted, off when the last one leaves. Overlapping routes (a
/// push-replacement from the setup key to the recovery codes) never drop the
/// flag in between.
class SecureWindow extends StatefulWidget {
  const SecureWindow({super.key, required this.child});
  final Widget child;

  static int _holders = 0;

  /// Mounted holders (tests).
  @visibleForTesting
  static int get holders => _holders;

  @visibleForTesting
  static void resetForTest() => _holders = 0;

  @override
  State<SecureWindow> createState() => _SecureWindowState();
}

class _SecureWindowState extends State<SecureWindow>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (SecureWindow._holders++ == 0) {
      SecurityPlatform.instance.setSecureWindow(true);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The flag stays on while backgrounded (that is what hides the Recents
    // thumbnail); re-assert it on return in case the window was recreated.
    if (state == AppLifecycleState.resumed && SecureWindow._holders > 0) {
      SecurityPlatform.instance.setSecureWindow(true);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (--SecureWindow._holders <= 0) {
      SecureWindow._holders = 0;
      SecurityPlatform.instance.setSecureWindow(false);
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
