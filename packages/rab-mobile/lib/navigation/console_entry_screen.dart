import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';
import '../core/auth/auth_provider.dart';
import '../core/theme/schedule_tokens.dart';

/// Existing Manager/Admin operations remain in the web console.
class ConsoleEntryScreen extends StatelessWidget {
  const ConsoleEntryScreen({super.key, this.unsupported = false});
  final bool unsupported;
  Future<void> _open(BuildContext context) async {
    const configured = String.fromEnvironment('CONSOLE_URL');
    final local = Uri.parse(context.read<AuthProvider>().api.baseUrl);
    final url = configured.isNotEmpty
        ? Uri.tryParse(configured)
        : !kReleaseMode
        ? local.replace(port: 5173, path: '/', query: '', fragment: '')
        : null;
    try {
      if (url == null ||
          !['https', 'http'].contains(url.scheme) ||
          !await launchUrl(url, mode: LaunchMode.externalApplication)) {
        throw StateError('Console unavailable');
      }
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Unable to open the management console. Contact your administrator.',
            ),
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: ScheduleTokens.homeBackground,
    body: SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                unsupported ? 'Account access' : 'Management console',
                style: ScheduleTokens.heading,
              ),
              const SizedBox(height: 16),
              Text(
                unsupported
                    ? 'This account has no supported mobile role. Contact your administrator.'
                    : 'Your Manager/Admin workspace is available in the existing web console.',
              ),
              const SizedBox(height: 24),
              if (!unsupported)
                FilledButton(
                  onPressed: () => _open(context),
                  child: const Text('Open management console'),
                ),
              TextButton(
                onPressed: context.read<AuthProvider>().logout,
                child: const Text('Sign out'),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
