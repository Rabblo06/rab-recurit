# Release note: strict on/off switches (Phase X3.1, XR-05 / ENV-01)

**Who must act:** every operator who sets any variable below on a host (runtime env file, compose override, platform
environment settings). **What can go wrong:** a value that is not exactly `true` or `false` now stops `rab-api` and
`rab-worker` from booting. Before this release the same value silently meant `false`.

## What changed

Fourteen on/off switches used to read `value === 'true'`. Any other value, `True`, `TRUE`, `1`, `yes`, `on`, ` true`
(leading space) or a typo such as `ture`, silently meant **false**. For example `USER_SESSION_ENFORCEMENT_CUTOVER=True`
left the session cutover off, and `EMAIL_DELIVERY_ENABLED=1` stopped every email.

They now use the same strict rule as the existing security switches (`strictBoolean`,
`rab-server/src/engine/core-modules/environment/environment-variables.ts`):

| Value | Result |
|---|---|
| `true` (lower case, no spaces) | on |
| `false` (lower case, no spaces) | off |
| unset, or empty (`KEY=`) | the default in the table below |
| anything else | **the process refuses to boot**: `Invalid environment configuration: <NAME> must be exactly true or false (lower case; unset or empty keeps the default)` |

The refusal names the variable, never its value.

## Affected variables

| Variable | Default when unset or empty | What it switches |
|---|---|---|
| `EMAIL_DELIVERY_ENABLED` | `true` | sending email at all |
| `AUTH_CONTEXT_CACHE_ENABLED` | `false` | Redis auth-snapshot cache |
| `USER_SESSION_CACHE_ENABLED` | `false` | Redis session-lookup cache |
| `CORE_ENTITY_CACHE_ENABLED` | `false` | Redis core-entity cache |
| `WORKSPACE_METADATA_CACHE_ENABLED` | `false` | Redis workspace-metadata cache |
| `WORKER_FAST_PUBLISH_NOTIFY` | `false` (the committed compose files pin `"true"`) | after-commit publish of notification email/push rows |
| `USER_SESSION_ENFORCEMENT_CUTOVER` | `false` | session-enforcement cutover |
| `AUTH_PASSWORD_ENABLED` | `true` | password sign-in |
| `AUTH_GOOGLE_ENABLED` | `false` | Google sign-in |
| `AUTH_MICROSOFT_ENABLED` | `false` | Microsoft sign-in |
| `AUTH_OAUTH_HANDOFF_ENABLED` | `false` | OAuth login handoff |
| `EMAIL_SMTP_NO_TLS` | `false` | plain-text SMTP (no TLS) |
| `REALTIME_ENABLED` | `false` | realtime (SSE) delivery |
| `PUSH_ENABLED` | `false` | push notifications |

Also: `S3_FORCE_PATH_STYLE` was already strict; it now goes through the same helper. No behaviour change.

Not changed: `AI_AGENTS_ENABLED` stays loose on purpose (only `true` turns it on; anything else is off, never a boot
refusal). See its comment in `environment-variables.ts`.

## Before you deploy

1. On every host, check the value of each variable above wherever it is set: the runtime env file
   (`${CREWFLOW_SECRETS_DIR}/runtime.env`), any compose override, and the platform's environment settings. Each must be
   exactly `true`, `false`, empty or absent.
2. Run the env-file lint on the runtime env file:
   `node packages/rab-docker/scripts/compose-owner-login.cjs --lint-env-file runtime ${CREWFLOW_SECRETS_DIR}/runtime.env`
   It refuses a value that is not exactly `true` or `false` for every variable above, and for every other strict switch
   (`APP_JWT_LEGACY_VERIFY_ENABLED`, `AUTH_MFA_*`, `WORKSPACE_HOST_ROUTING_ENABLED`, `HWS_RUNTIME_ENABLED`, ...). The gate
   reads that list from `environment-variables.ts`. `PUSH_ENABLED` and `REALTIME_ENABLED` must also be non-empty there.
3. If a host refuses to boot after the upgrade, the log line names the variable. Fix its value to `true` or `false`
   (choose the one the old behaviour gave: any value other than exactly `true` used to mean `false`) and restart.

The committed compose files and templates (`docker-compose*.yml`, `env/*.example`, `rab-server/.env.example`) contain only
`true` / `false` for these variables (checked for this release).

## Rollback

Redeploy the previous image. No data or schema change is involved.
