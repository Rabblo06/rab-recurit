# rab — working agreements for AI-assisted development

Workforce staffing platform: one NestJS backend, one PostgreSQL database, three
clients (`rab-front` web console + venue portal, `rab-mobile` staff app). Full
architecture, ERD, permission matrix, API structure, schema and milestone plan
live in `rab-workforce-architecture.md` at the repo root — read it before making
structural changes.

## Non-negotiable rules

- **Five enforcement layers on every sensitive operation, not one:** guard →
  service → org-scope query → **RLS policy** → (staff/venue-scoped tables) a
  second, tighter RLS predicate. A control that exists at only one layer is
  not implemented. Layer 2 (the service-level check) is the one people skip —
  put it in the service, not only the resolver/controller, because jobs, CLI
  commands and other services call services directly and never pass through a
  guard. See `rab-workforce-architecture.md` §5.2 and §5.7.
- **`organisationId` never comes from the client.** It is read from the
  verified session/token and bound into the DB session via `SET LOCAL`
  (`TenantContextService`). A request body containing `organisationId` is a
  validation failure (400), not a hint, and never a silent override.
- **Every tenant-scoped table gets `organisation_id` + an RLS policy
  (`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `USING` +
  `WITH CHECK`) in the *same* migration that creates it.** No exceptions, no
  "add the policy later" follow-up PR. `tools/check-rls-coverage.ts` enforces
  this in CI starting M1. **Exception:** a table read by a pre-auth lookup
  (identifying *which* organisation a request belongs to — by email, by
  slug, by presented token hash — before any tenant context can exist to
  satisfy a forced policy) skips `FORCE` only, never `ENABLE`, and gets a
  `SECURITY TRADE-OFF` note explaining which lookup needs it. `organisation`,
  `user`, `login_history` and `refresh_token` are the four so far (see
  IdentitySchema1786665800000) — check whether a new table is read by
  `AuthService` before context exists before assuming it needs this
  exception; most tables don't.
- **Fail closed.** A permission check that throws denies. Missing config
  refuses to boot (env is validated on process start). An unknown state
  transition is rejected, never silently accepted. A query run with no tenant
  context bound returns zero rows, never all rows.
- **404, not 403, for a record outside the caller's tenant, venue, or own
  scope.** A 403 confirms the row exists, which is itself a disclosure. 403 is
  reserved for "this exists and you may see it exists, but you categorically
  lack the permission" (e.g. a `MANAGER` hitting `payroll:approve`).
- **No raw `status` value ever accepted from a client.** Mutations name the
  action (`publishShift`, `acceptOffer`), not the target state
  (`updateShift({status: 'PUBLISHED'})`). Transitions are validated against the
  tables in `rab-workforce-architecture.md` §1.1 via `assertTransition`, which
  throws `InvalidTransitionError` (409) on anything not explicitly listed.
- **`engine/` never imports from `modules/`.** `engine/` is platform machinery
  (auth, permissions, secrets, audit, file storage, email, queue, tenant
  context). `modules/` is the staffing domain (staff, venue, scheduling,
  attendance, payroll). The dependency only flows one way.
- **Money is always `bigint` pence.** Never a float, never a string used for
  arithmetic. Use `@rab/shared`'s `money.ts`.
- **Worked-minutes calculation lives in exactly one place**: `@rab/shared`'s
  `duration.ts`. Mobile timer, attendance console and payroll engine all import
  it. Do not reimplement it anywhere.
- **Permissions are resolved server-side per request**, never read off the JWT.
  Use the `PermissionGuard(flag)` mixin factory declaratively on the
  handler — never an inline `if` check in a resolver/controller body.
- **`audit_log` is insert-only.** No update/delete route may ever be added for
  it, at the application layer or the database grant (`REVOKE UPDATE, DELETE
  ... FROM rab_app` in the same migration that creates the table).
- **Rate resolution is snapshotted at confirmation** (`assignment → staff role
  rate → venue role rate → org default`), never recalculated later. A rate
  change must not reprice historical work.
- **Passwords hash with argon2id** (`m=19456, t=2, p=1` minimum), never
  bcrypt/MD5/SHA/custom crypto. Login responses are timing- and
  message-uniform for wrong-email vs wrong-password — run the hash even when
  the account doesn't exist.
- **Migrations only.** `synchronize: false` always. Every schema change is a
  versioned TypeORM migration, never edited after merge.
- **No mock production logic.** No fake login, fake timer, fake sync between
  web and mobile, or seeded dashboard numbers. A running-shift timer renders
  `serverNow − clockInAt` from the attendance record, never client-local
  elapsed time — a client-driven timer both fakes progress and lets a changed
  device clock inflate paid hours.
- **Never invent a business rule silently where it touches payroll, compliance,
  permissions, attendance, or data retention.** Flag the assumption explicitly
  instead — see `rab-workforce-architecture.md` §1 for the assumptions already
  agreed (A1–A12).

## When you find a security gap

Use the **security finding** format in `rab-workforce-architecture.md` §5.8 —
severity, actor→action→consequence, file:line, root cause, fix, regression
test. Never write "consider improving security" as a substitute for a finding.

## When you choose convenience over a stricter control

Stop and write the **security trade-off** block from §5.8 in your response so
it can be vetoed before it ships.

## Commands

```bash
yarn start   # server + front concurrently, worker after server is healthy
yarn mobile  # Expo dev server for rab-mobile
yarn build   # nx run-many build across the workspace
yarn lint    # nx run-many lint
yarn test    # nx run-many test
```

## Resolved gotchas (read before you hit them again)

- **`@rab/shared`/`@rab/ui` are dual-published (CJS + ESM).** Each builds
  twice — `tsconfig.lib.json` (ESM, → `dist-esm`) for Vite/browser consumers,
  `tsconfig.lib.cjs.json` (CommonJS, → `dist-cjs`) for Node/`rab-server`
  consumers — selected via `package.json`'s `exports` map
  (`import`/`require` conditions). `dist-cjs/package.json` (`{"type":
  "commonjs"}`, written by the build) overrides the package-level `"type":
  "module"` for just that directory — without it Node treats every `.js`
  under the package as ESM regardless of which build produced it. If you add
  a third workspace library that's imported from both `rab-server` and
  `rab-front`/`rab-mobile`, copy this pattern, don't reinvent it.
- **`rab-server`'s dev/migration/command entrypoints run on `ts-node`
  (`--transpile-only`), never `tsx`.** `tsx` is esbuild-based and does not
  implement TypeScript's `emitDecoratorMetadata` — any file with a
  TypeORM/NestJS decorator that relies on reflected property types (e.g.
  `@PrimaryGeneratedColumn()`, `@Column()` with no explicit `type`) throws
  `Cannot read properties of undefined ('constructor')` under `tsx`, silently
  works under `ts-node`. `rab-front`'s Vite dev server is unaffected (esbuild
  there only ever transpiles plain React/TS, no runtime-reflected decorators).
- **Every `@Column()` on a property typed with a `@rab/shared` string-union
  alias (`UserStatusType`, `PayrollRecordStatusType`, ...) needs an explicit
  `type: 'text'`.** TS type aliases don't exist at runtime, so
  `emitDecoratorMetadata` reflects them as `Object`, and TypeORM rejects
  `Object` as an unsupported column type. Plain `string`/`boolean`/`Date`
  properties don't need this — only alias types.

## Conventions

- Prettier: `singleQuote`, `trailingComma: all`, `endOfLine: lf`.
- Every domain module under `modules/` follows the same internal shape:
  `*.module.ts`, `controllers/`, `resolvers/`, `services/`, `entities/`, `dto/`,
  `jobs/`, `listeners/`, `constants/`, `exceptions/`, `__tests__/`.
- Resolvers and controllers are transport adapters only — business logic lives
  in `services/`, called identically from both, so a rule enforced on the
  console can never be missing on mobile or vice versa.
- `class-validator` DTOs use `forbidNonWhitelisted: true` globally (already
  wired in `main.ts`) — the anti-mass-assignment control. A body carrying
  `organisationId`, `status`, or any field the DTO doesn't declare gets a 400,
  not a silently-ignored or silently-applied field. Never spread a client
  object into an entity update; map allowed fields explicitly.

## Testing floor

From M1 onward (the moment auth + tenancy exist), every PR touching
authorisation, tenancy, or a state machine needs the matching **abuse-case**
test from `rab-workforce-architecture.md` §1.2 — the denial, not just the
happy path. Every new tenant-scoped table needs an integration test that runs
a query with no tenant context bound and asserts zero rows back.
`THREAT-MODEL.md` gets a new entry, in the same PR, for any feature touching
auth, money, or another person's data — not written after the fact.
