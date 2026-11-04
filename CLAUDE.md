# rab — working agreements for AI-assisted development

Before modifying code, read `docs/HANDOFF.md` completely, inspect git status/diff,
and verify the handoff against current code. Continue relevant pending work;
do not trust stale text over repository evidence. Update that same canonical
handoff after substantial changes, including important new production modules.

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
- **One runtime login: the owner login `crewflow_owner`** (owner's final
  decision 2026-11-04, Option A, permanent; THREAT-MODEL.md PT-01). The API,
  the Worker, the CLI and the short-lived migration child all connect as it
  through one `PG_DATABASE_URL`. Its shape is fixed (M0 §5.1): NOSUPERUSER,
  NOBYPASSRLS, NOREPLICATION, NOCREATEDB, CREATEROLE; it INHERITs
  `rab_secure_owner` and `crewflow`, so it **owns every table**. The legacy
  roles `rab_owner`, `rab_app`, `rab_secure_owner`, `crewflow`,
  `crewflow_app` and `crewflow_worker` remain as **schema roles** that
  historical migrations and SECURITY DEFINER functions need. None of them is
  a runtime login, and a process connecting as one of them is refused. The
  boot gates, `assertRuntimeDbRole` and `tools/check-rls-coverage.ts` enforce
  the exact owner-login shape through ONE shared rule set
  (`database/boot-checks/owner-login-posture.ts`): the login itself (no SET
  ROLE); a MEMBER-semantics reachability walk that may reach nothing
  SUPERUSER, BYPASSRLS, CREATEDB, REPLICATION, dangerous-predefined or
  provider-admin; the exact role inventory; FORCE everywhere; and the
  expected ownership. Never add a second validator or a mode switch.
  Every protection the former restricted login gave and this one cannot
  keep is in the reviewed behaviour-change catalogue
  (`owner-login-behaviour-catalogue.ts`), with a severity and a reproducing
  test. A catalogue difference is never "fixed" by flipping a test to pass.
- **Every tenant-scoped table gets `organisation_id` + an RLS policy
  (`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `USING` +
  `WITH CHECK`) in the *same* migration that creates it.** No exceptions, no
  "add the policy later" follow-up PR. **FORCE is now mandatory on every
  table without exception**: the runtime login is the owner, so a NOT FORCE
  table is unscoped for every query it runs, with no injection needed (G-01).
  `tools/check-rls-coverage.ts` enforces this; its `NOT_FORCED_ALLOWLIST` is
  empty and must stay empty.
  - **Pre-auth lookups** need to find a row before any tenant context exists
    (by email, slug or presented token hash). They use the M-T1 pattern
    (PreAuthTablesForceOwnerOnly1786721400000), never NOT FORCE:
    - the table is owned by the NOLOGIN `rab_secure_owner`;
    - it has FORCE, plus one PERMISSIVE policy `<table>_secure_owner_definer`
      TO rab_secure_owner USING / WITH CHECK
      `(CURRENT_USER = 'rab_secure_owner'::name)`;
    - the lookup is a narrow SECURITY DEFINER function owned by
      `rab_secure_owner`, with a pinned `search_path`.
  - Sixteen tables use this pattern today. The authoritative list is
    `PREAUTH_FORCE_TABLES` (`preauth-force-sql.ts`):
    - `user`, `login_history`, `refresh_token`, `password_reset_token`,
      `manager_workspace`, `worker_due_work`, `account_invite`,
      `user_session`, `user_auth_identity`, `member_invitation`,
      `email_change_request`, `released_host_label`, `login_handoff`,
      `organisation_invitation`;
    - `organisation` and `platform_admin` (no `organisation_id`, so they are
      checked in a separate pass).
  - A migration or script that reads or writes one of these tables as the
    owner login must `SET LOCAL ROLE rab_secure_owner` or go through a
    definer. Otherwise it sees zero rows: an "is the database empty?" check
    must never count these rows as the owner login.
  - Three `core` tables have no RLS at all because they hold no tenant data
    and no `organisation_id`: `migrations`, `permission` (global reference
    data) and `oauth_transaction_state` (pre-identity OIDC state, justified in
    OAuthTransactionState1786680300000).
  - RLS binds the owner login on **normal code paths only**. An injected
    statement can `SET ROLE`, rewrite a policy or drop FORCE. The owner
    accepted this (final prompt §2; THREAT-MODEL.md PT-01). The semantic
    posture monitor detects the change afterwards; it does not prevent it.
- **Write invariants that used to rest on a missing grant need a
  grant-parity guard.** The owner login inherits every privilege of the
  table owner. So "crewflow_app has no UPDATE/DELETE here" no longer
  protects anything on its own. Payroll immutability, definer-only writes
  and retention are examples (PAY-1).
  - In the same migration that creates such a table, attach
    `core.owner_login_grant_parity_guard()`
    (OwnerLoginGrantParityGuards1786721420000).
  - Add the table to `GRANT_PARITY_TARGETS`.
  - Writes then go through a SECURITY DEFINER function owned by `crewflow`
    or `rab_secure_owner`, or after `SET LOCAL ROLE crewflow` (migrator,
    provisioner).
- **Never change the session role at session level.** Use only `SET LOCAL
  ROLE` / `set_config('role', …, true)` inside a transaction, and restore it
  where the caller's transaction continues. A session-level SET ROLE
  survives COMMIT and would poison the pooled connection (G-09). Pools reset
  the role on checkout and `TenantContextService` asserts `current_user =
  session_user` (`database/postgres/session-role-reset.ts`). Never use
  `DISCARD ALL` inside a transaction.
- **New database objects are owned by a schema role, never by the login.**
  - Tables, functions and schemas belong to `crewflow` (through
    `withCrewflowCoreCreate`) or `rab_secure_owner`.
  - The boot gate refuses anything in `core`, `public` or a workspace schema
    that `crewflow_owner` owns directly.
  - A change to a policy, function body, trigger, RLS flag or the audit_log
    ACL also changes the semantic posture golden (`posture-drift/`). Regenerate
    the golden for each PG major from a migrations-only database and review it
    like code. Never regenerate it from a database under investigation.
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
- **`audit_log` is insert-only.**
  - No update or delete route may ever be added for it, at the application
    layer or in the database grants. `UPDATE`, `DELETE` and `TRUNCATE` are
    revoked from `crewflow` (the owner) and from `crewflow_app` in the same
    migration that creates the table.
  - Since the owner login, the database can no longer guarantee this against
    injected SQL: the owner can re-grant itself (BC-07, owner-accepted).
    Security-relevant events are therefore also emitted to the external
    append-only audit sink (`engine/core-modules/audit-sink`).
  - Production refuses to start without that sink (`CREWFLOW_AUDIT_SINK`)
    and fails closed when a write to it fails.
- **Rate resolution is snapshotted at confirmation** (`assignment → staff role
  rate → venue role rate → org default`), never recalculated later. A rate
  change must not reprice historical work.
- **Passwords hash with argon2id** (`m=19456, t=2, p=1` minimum), never
  bcrypt/MD5/SHA/custom crypto. Login responses are timing- and
  message-uniform for wrong-email vs wrong-password — run the hash even when
  the account doesn't exist.
- **Migrations only.** `synchronize: false` always. Every schema change is a
  versioned TypeORM migration, never edited after merge.
- **Every value reaches SQL as a bound parameter; every identifier comes from
  an allow-list.** One injected statement runs with the schema owner's
  privileges (PT-01).
  - `tools/check-sql-injection.cjs` fails CI on any template-literal SQL with
    `${…}`, any dynamic WHERE / ORDER BY builder and any DDL identifier
    template unless it carries a reviewed `// sql-injection-reviewed: <why>`
    comment.
  - The lint is a text scan, not a complete defence. The adversarial tests
    and the reviews remain required.
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
- **Client apps (`rab-front`, `rab-mobile`) are feature-per-folder, not
  type-per-folder.** New code goes inside its feature's folder — never in a
  top-level `pages/`, `components/`, or `lib/` bucket sorted by file kind;
  those don't exist in `rab-front` anymore, on purpose. Each feature folder
  owns its own page(s), drawers/modals, and feature-local styles, and should
  be self-contained: importable on its own, without another feature reaching
  into it.
  - `rab-front`: `src/features/<domain>/` — currently `auth`, `dashboard`,
    `users`, `scheduling`, `offers`, `venues`, `payroll`, `audit`,
    `notifications`, `settings`.
  - `rab-mobile`: `lib/features/<domain>/` — the same rule, already in place
    before `rab-front` adopted it; match its shape for new mobile domains.
  - `src/shared/` (`rab-front` only) is for code used by **three or more**
    features — the `api` client, `theme`/`timeAgo` utils, generic UI
    primitives (`Drawer`, `ViewBar`, `TableFooter`, `RightSidePanel`). Used
    by only one or two features → it belongs in those features' folders, not
    `shared/`. Don't pre-emptively generalize a component just because it
    might be reused someday.
  - `src/shell/` (`rab-front` only) is the app chrome that composes
    features (`Layout`, `AdminDropdown`, `GlobalSearch`, `CommandPalette`).
    It may import from any feature; no feature may import from `shell/`.
  - This is the same underlying rule as `modules/<domain>/` above, just
    shaped differently per runtime (NestJS module vs. React feature vs.
    Flutter feature) — find code by domain, never by file type.
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
