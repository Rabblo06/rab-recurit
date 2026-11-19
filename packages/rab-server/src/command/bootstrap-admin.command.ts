import { Command, CommandRunner } from 'nest-commander';
import { DataSource } from 'typeorm';

import { AuditService } from '../engine/core-modules/audit/audit.service';
import { AccountLifecycleService } from '../engine/core-modules/auth/services/account-lifecycle.service';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import {
  PlatformAdminBootstrapEvent,
  PlatformAdminBootstrapService,
  readPlatformAdminBootstrapInput,
} from '../modules/identity/platform-admin-bootstrap/services/platform-admin-bootstrap.service';

/**
 * 2026-11-19 (first platform admin at API boot): the bootstrap body moved, unchanged, into
 * `PlatformAdminBootstrapService` (modules/identity/platform-admin-bootstrap), so the API's boot-time bootstrap
 * (`PlatformAdminBootstrapOnBoot`) runs EXACTLY this code path. This command keeps its constructor, its inputs, its output
 * lines, its self-heal of an existing admin, its audit metadata and its fail-loud CLOSED; it only wires the shared service.
 * Note on the P2 text below: under the owner-login architecture the runtime login `crewflow_owner` is an INHERIT member of
 * `crewflow` and therefore holds EXECUTE on the function (BC-11, accepted 2026-11-05); the schema role `crewflow_app` still
 * does not. The API boot path relies on exactly that, and on the function's own one-time guarantee.
 */
/**
 * Foundation fix P2 (2026-10-22) — how this command is authorised and why it no longer needs a superuser.
 *
 * The one step that needs more than ordinary tenant-scoped authority (finding/creating the organisation and user and
 * inserting the FIRST `core.platform_admin` row — tables owned by the NOLOGIN `rab_secure_owner`) is the narrow SECURITY
 * DEFINER function `core.bootstrap_first_platform_admin` (migration 1786719620000). It holds this command's advisory lock,
 * is one-time (it returns ALREADY_BOOTSTRAPPED / CLOSED once any platform admin has ever existed, so it can never mint a
 * second or replacement administrator), and only `crewflow` may EXECUTE it — never `crewflow_app`, so no API/Worker
 * request path can reach it. Run the command with `PG_DATABASE_URL` set to the `crewflow` identity (the same operator
 * identity as the other one-off commands); the bootstrap superuser also works but is not needed. Everything after the
 * grant — the operational CEO role, the activation invitation and the audit entry — runs as that same connection under
 * ordinary FORCE RLS, with the tenant context bound by `TenantContextService` (no RLS bypass, no new grant).
 * The "History" notes below describe the pre-split design this replaces.
 */

/**
 * History — P2.9A — automatic, env-driven first-Platform-Admin bootstrap, invoked once on every container
 * boot (`start.sh`, after migrations, before `main.js`), never on-demand. ONLY
 * `BOOTSTRAP_ADMIN_EMAIL` is read — there is deliberately no `BOOTSTRAP_ADMIN_PASSWORD` any more
 * (the owner's own non-negotiable rule for this checkpoint: "Do not configure an initial
 * administrator password in environment variables"). A brand-new admin account is created
 * `INVITED`, with no password at all, and goes through the EXACT SAME invitation-token/
 * `/auth/activate-account` path every Staff/Manager/Venue-Manager invite already uses
 * (`AccountLifecycleService.sendAccountInvite`, reused verbatim here — only the email subject
 * differs, via `renderSuperAdminActivationEmail`). No session is ever issued to this row until the
 * recipient completes that flow themselves; an `INVITED` user with no `password_hash` cannot log in
 * (`AuthService.login`'s own `ACTIVE || (INVITED && passwordHash !== null)` gate) — so there is no
 * window where a "pending administrator" has a usable session.
 *
 * Reuses, rather than re-implements, the existing bootstrap security model:
 * `grant-platform-admin.command.ts`'s own doc comment states the first
 * grant can only ever happen by writing directly as `rab_owner` (this
 * table is deliberately NOT FORCEd for exactly that reason) — this command
 * runs the same way (historically via the `DATABASE_URL_UNPOOLED`-as-`rab_owner`
 * convention; X3.5-S6: one PG_DATABASE_URL now). The "existing user by
 * email, refuse on cross-org ambiguity" lookup below is the same shape as
 * `grant-platform-admin.command.ts`'s, not a second, competing algorithm —
 * an email that already matches a real, already-activated account is
 * granted directly (no invite needed; that person can already log in).
 *
 * Idempotency/no-duplication (owner's rules: "no repeated creation after server restarts", "no
 * duplication when two API replicas start simultaneously") is the SAME mechanism as before,
 * unchanged: a transaction-scoped advisory lock held for the whole check-then-act block, keyed on
 * `core.platform_admin`'s row count. Once the first admin exists (pending activation or not), every
 * later boot — including a concurrent second replica blocked on the same lock — sees a non-zero
 * count and cleanly no-ops. This IS "permanently disable the initial bootstrap path after
 * completion" (owner's rule): there is no separate flag to maintain, because the condition this
 * command checks can never become false again once satisfied.
 *
 * Everything runs on ONE manager from a single `dataSource.transaction()`
 * — deliberately not `TenantContextService.runInTenantContext`, which
 * always opens its own separate transaction/connection. Nesting that
 * inside this one would mean the advisory lock below (held on THIS
 * transaction's connection) provides no protection at all for the actual
 * writes, and they could commit independently of this transaction's
 * outcome. `organisation`/`user`/`platform_admin` are all NOT FORCEd, so
 * `rab_owner` (the table owner) bypasses their RLS unconditionally with no
 * context needed; `audit_log` IS FORCEd, so its one insert gets an inline
 * `set_config` on this same manager instead, right before it's needed.
 * `AccountLifecycleService.sendAccountInvite` itself issues further raw
 * queries/inserts on this SAME manager — it takes no transaction of its own,
 * so it participates in this one exactly like every other raw query here.
 */
@Command({
  name: 'bootstrap-admin',
  description: 'One-time, env-driven bootstrap of the first Platform Admin on a fresh deploy (idempotent, safe to run every boot)',
})
export class BootstrapAdminCommand extends CommandRunner {
  private readonly bootstrap: PlatformAdminBootstrapService;

  constructor(dataSource: DataSource, auditService: AuditService, accountLifecycle: AccountLifecycleService, tenantContext: TenantContextService) {
    super();
    // The shared implementation over THIS command's own connection (the integration suites construct the command over a
    // specific identity's DataSource; the service must run on that same one).
    this.bootstrap = new PlatformAdminBootstrapService(dataSource, auditService, accountLifecycle, tenantContext);
  }

  async run(): Promise<void> {
    const input = readPlatformAdminBootstrapInput(process.env);
    if (!input) return; // not configured — ordinary boot, nothing to do

    // Deprecated, deliberately ignored rather than treated as fatal — an operator who hasn't yet
    // removed it from an old deploy config shouldn't have their boot fail over it, but it must
    // never be read or applied (owner's rule).
    if (process.env.BOOTSTRAP_ADMIN_PASSWORD) {
      console.warn('BOOTSTRAP_ADMIN_PASSWORD is set but no longer used — Super Admin bootstrap is email-only now (an activation link is emailed instead). Remove this variable.');
    }

    const normalizedEmail = input.email;
    const onEvent = (event: PlatformAdminBootstrapEvent): void => {
      if (event.kind === 'organisation-created') console.log('Platform Admin bootstrap: the bootstrap organisation did not exist — created it.');
      else if (event.kind === 'granting-existing-user') console.log(`Platform Admin bootstrap: granting the existing user "${normalizedEmail}" rather than creating a new one.`);
      else console.log(`Platform Admin bootstrap: granted operational CEO-shaped role to user ${event.userId} (org ${event.organisationId}).`);
    };

    const result = await this.bootstrap.run(input, { trigger: 'command', selfHealExistingAdmin: true, onEvent });

    switch (result.outcome) {
      case 'ALREADY_BOOTSTRAPPED':
        console.log('Platform Admin already exists — bootstrap skipped');
        return;
      case 'CLOSED':
        // Fail closed and loudly: the one-time bootstrap is spent. Restoring an administrator after every one has been
        // revoked is a deliberate DBA action (grant-platform-admin), never an env-driven boot side effect.
        throw new Error(
          'Platform Admin bootstrap is closed: platform administrators have existed on this database but none is active. ' +
            'Nothing was changed. Restoring one is a deliberate operator action (grant-platform-admin), not a bootstrap.',
        );
      case 'REFUSED_AMBIGUOUS_EMAIL':
        console.error(
          `Platform Admin bootstrap: "${normalizedEmail}" matches more than one existing user across different organisations — refusing to guess. ` +
            `Run "grant-platform-admin --email ${normalizedEmail} --org <slug>" manually instead.`,
        );
        return;
      case 'REFUSED_AMBIGUOUS_ORGANISATION':
        console.error(
          `Platform Admin bootstrap: several organisations exist and none has a user matching "${normalizedEmail}" — refusing to guess which one. ` +
            `Set BOOTSTRAP_ADMIN_ORG_SLUG explicitly, or run "grant-platform-admin --email <existing-user-email> --org <slug>" manually instead.`,
        );
        return;
      case 'CREATED_INVITED':
        console.log(`Platform Admin bootstrapped (user ${result.userId}) — pending activation, activation email queued.`);
        return;
      case 'GRANTED_EXISTING':
        console.log(`Platform Admin bootstrapped (user ${result.userId}).`);
        return;
    }
  }
}
