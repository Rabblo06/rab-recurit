# Crewflow mobile

Flutter Staff / Venue Manager app. Read `../../docs/HANDOFF.md` before changes.
Android package identity remains `com.rab.rab_staff`; company wording is unchanged.

## API environments

`API_URL` is a compile-time dart define. Supply the complete base including
`/rest/v1`; callers append paths such as `/auth/login` and `/auth/me`.
Debug without a define uses Android emulator `http://10.0.2.2:3000/rest/v1`
(or localhost on other platforms). Profile/release without a define uses
`https://api.rabworkspaceteams.co.uk/rest/v1`.
An installed APK retains its compiled setting until rebuilt/reinstalled.

```powershell
flutter run -d emulator-5554 --dart-define=API_URL=http://10.0.2.2:3000/rest/v1
flutter build apk --debug --dart-define=API_URL=https://api.rabworkspaceteams.co.uk/rest/v1
flutter build apk --release --dart-define=API_URL=https://api.rabworkspaceteams.co.uk/rest/v1
adb -s <physical-device> install -r build/app/outputs/flutter-apk/app-debug.apk
adb -s <physical-device> shell am start -n com.rab.rab_staff/.MainActivity
```

Only debug Android resources permit HTTP to localhost/emulator. Profile/release
require HTTPS. The current release Gradle config uses the debug signing key:
building a release APK is a compilation check, not Play Store release readiness.
Do not uninstall or clear data just to refresh branding; use `install -r` first.

## Branding

Source: `image/image.png` (1254x1254 RGB, white background). Android launcher
label and Flutter application title are Crewflow. Business identity text stays
Adolphus. Reproducible Android-only generators are configured in pubspec.yaml:

```powershell
dart run flutter_launcher_icons
dart run flutter_native_splash:create
```

Adaptive launcher uses white background and 20% additional foreground inset.
Native launch assets include light/dark and Android 12+ resources. No artificial
startup delay or extra Flutter splash is introduced. Bootstrap retains its
existing progress indicator and authentication gates.

## Verification

```powershell
flutter clean
flutter pub get
flutter analyze
flutter test
```

See `docs/CREWFLOW-PIXEL-DEPLOYMENT.md` for actual device verification and limits.
