# Crewflow Pixel Deployment — Final Report

2026-10-02. Installed for real-device testing; successful login and original-error diagnosis remain incomplete.

## 1. Root cause of Internal Error
Not proven. Available old logs did not capture the reported failure. Current login already maps 401, server errors and network exceptions to safe messages. No Internal Error literal found in old APK kernel. New phone attempt showed Invalid email or password (HTTP 401), not the reported old error. No auth/backend redesign performed.

## 2. Previous API URL
Source and source embedded in old installed debug APK defaulted all modes to Android http://10.0.2.2:3000/rest/v1 (other platforms localhost). API_URL overrides it. Old runtime override could not be read: standalone debug VM lacked compilation service. Do not conflate source default with proven old runtime URL.

## 3. Final API URL
https://api.rabworkspaceteams.co.uk/rest/v1 — evaluated directly from ApiClient().baseUrl in the installed Pixel process.

## 4. Configuration mechanism
Existing compile-time API_URL retained. Debug keeps local defaults; profile/release default public HTTPS. Overrides trim surrounding whitespace/trailing slash. Both APK builds supplied explicit production define. Client appends /auth/login etc.; /rest/v1 appears once.

## 5. Android network verification
Existing INTERNET permission retained. Main cleartext denied; existing localhost/emulator HTTP allowances moved to debug resources. Pixel DNS resolved public hostname. Computer health200/auth-me401 with valid TLS. Read-only http.get inside actual Pixel app: health200, anonymous versioned auth/me401. One earlier health request failed with _ClientSocketException; retry succeeded. No TLS bypass, API proxy or adb reverse. Debugger loopback forwarding is separate from API traffic.

## 6. App name
Android label and MaterialApp title Crewflow. Package com.rab.rab_staff and Adolphus company/onboarding text unchanged.

## 7. Launcher icon
flutter_launcher_icons 0.14.4 generates mdpi–xxxhdpi and adaptive icon, white background, 20% additional inset. Pixel launcher screenshot visually confirms Crewflow and custom logo, old Flutter icon absent.

## 8. Splash screen
flutter_native_splash 2.4.7 generates white native launch resources, light/dark. No artificial delay or extra in-app splash; existing Flutter bootstrap progress indicator retained (no FlutterLogo widget).

## 9. Android 12+ splash
values-v31/night-v31 set windowSplashScreenBackground white and windowSplashScreenAnimatedIcon to android12splash. Pixel is Android17. Cold-launch capture caught a black transition frame; native splash appearance/timing is NOT visually certified. Resources/build verified, physical visual review pending.

## 10. Image asset
image/image.png, original1254x1254 RGB/no alpha. Square white-backed logo retained unchanged. Generated platform assets reproducible through pubspec. No unrelated platform branding.

## 11. Flutter analyze
Passed, no issues (36.1s). Evidence .audit/crewflow-pixel/analyze.log.

## 12. Flutter tests
Full386 tests passed (87s), including auth/biometric/cold-lock and three new API configuration checks. Evidence tests.log. No skipped tests in this run.

## 13. APK build
flutter clean/pub get completed. Debug154.8s; release282.9s,77.2MB. Both explicit public API. Artifacts build/app/outputs/flutter-apk/app-debug.apk and app-release.apk. Existing release Gradle uses DEBUG signing key: compilation verified, not store-ready signing. Release not installed/published. Existing Java8 source/target warnings remain.

## 14. Connected Pixel
Real Pixel7 authorised after USB approval. Every installation/device command explicitly targeted physical phone, not separately connected emulator. USB reconnected during diagnostics; debugger reattached.

## 15. APK installation
adb install -r returned Success. No uninstall/data clear/signature bypass/account reset. Existing package identity preserved.

## 16. App launch
am start -W returned Status ok, COLD,1511ms. Real Login observed and launcher label/icon visually verified. Subsequent cold launch retained data.

## 17. Real API connectivity
Phone health200 and anonymous /rest/v1/auth/me401 via normal TLS. Safe evidence .audit/crewflow-pixel/phone-network-safe.log. Earlier transient socket failure disclosed. Installed resolved base is public, with no fallback to local API.

## 18. Login verification
Incomplete: observed Invalid email or password means login401. User asked to enter valid production TEST account on phone. Successful login -> authenticated auth/me -> correct role Home not yet verified. Local-dev credentials need not exist in production. No credential reuse, resets or guessing performed.

## 19. Logs
Safe status/type diagnostics only retained. A diagnostic screenshot caught a visible password and was immediately deleted locally; never retained in report. No tokens/storage extracted. Old APK saved locally for comparison. Historical source/docs loopback matches are not proof of runtime requests.

## 20. Files changed
Mobile README; pubspec.yaml/lock; lib/app.dart; lib/core/api/api_client.dart; test/api_configuration_test.dart; Android manifest, main/debug network XML, generated drawable/mipmap/values resources; this report; root docs/HANDOFF.md. User image directory already untracked. Existing unrelated root untracked docs preserved. No server/worker/frontend/auth-provider edits.

## 21. Remaining issues and final answers
1. Old source default emulator address: yes; old runtime override unknown.
2. Original Internal Error cause: unproven.
3. New Pixel API: https://api.rabworkspaceteams.co.uk/rest/v1.
4. Public backend reached: yes, phone health200/auth401.
5–6. App title/launcher label Crewflow: yes.
7–8. Supplied icon used/Flutter launcher gone: yes, visually verified.
9–11. Flutter/native/Android12+ splash resources replaced: yes; actual native visual acceptance pending.
12–14. Analysis/tests/debug and release builds: pass.
15–17. Physical install, adb Success, launch: verified.
18. Successful login: not yet; observed credential rejection.
19. Resolved runtime API public, no local fallback; no full packet-capture claim. Debug local endpoints intentionally remain for development.
20. Ready for real-device testing; not fully accepted production release.

Next: valid production test-account login and physical splash review; capture exact failing request if original error recurs. Proper release signing remains required before distribution.

Tool references: https://pub.dev/packages/flutter_launcher_icons and https://pub.dev/packages/flutter_native_splash.
