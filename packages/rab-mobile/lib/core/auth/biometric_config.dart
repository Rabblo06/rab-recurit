/// Single source of truth for how long a biometric-only unlock remains
/// acceptable after the last full email+password login before the app
/// forces real credentials again. Referenced by `AuthProvider` (phase
/// computation) and any UI copy describing the policy — never hardcode
/// this number anywhere else.
const int biometricFullReauthDays = 30;
