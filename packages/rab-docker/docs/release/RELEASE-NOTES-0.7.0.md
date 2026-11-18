# Crewflow 0.7.0 release notes (DRAFT: needs the owner's deploy approval)

Status: draft. Nothing in this release is published or deployed until the owner approves the gated image publish and the
deploy. The production digest default in `docker-compose.production.yml` is bumped in a separate reviewed change after the
publish.

## What 0.7.0 is

0.7.0 is the release that switches C3 on (owner decision 2026-11-15, Part C3 Q8: "C3 ships in its own release").

- **Workspace data moves into each workspace's own schema.** The release registers the cutover step. `HWS_RUNTIME_ENABLED`
  becomes `true` on rab-api and rab-worker in the **deploy change** that also bumps the production digest to the published
  0.7.0 image, never before: `verify-image-compose` refuses HWS on with an image older than 0.7.0. On the first start with
  HWS on, the upgrade step `0.7.0_HwsCutover_1786721540100` copies every workspace's
  rows from the shared `core` tables into its schema. It then checks the copy (row counts, every row in both directions,
  checksums, money in pence and worked minutes) before that workspace is served from its schema.
- **The copy is safe to interrupt.** A workspace being copied answers 503 "workspace is being upgraded". A failed or
  interrupted copy keeps it blocked, never half-switched, and the next start continues where it stopped. Each start
  spends at most about 5 minutes on the copy.
- **The core copies are never changed.** After the cutover they are read-only for the application.
- **Version:** root `package.json` 0.7.0; `CREWFLOW_PREVIOUS_VERSIONS` gains 0.6.0.
- **Upgrade path:** from 0.7.0 on, the code upgrades strictly from the previous release. **0.7.0 accepts only a database
  that completed 0.6.0.** An R254 (0.4.0) or R256 (0.5.0) database must take 0.6.0 first.

## Operator steps (required)

Runbook: `docs/release/MIGRATION-AND-ROLLBACK-PLAN.md` §4.7. In short:

1. Stop the API and the Worker.
2. Take a `pg_dump --format=custom` of this database, restore it into a scratch database and compare the 21 core table
   counts.
3. Write `marker.json` next to the dump (exact fields in the runbook), and set `CREWFLOW_HWS_CUTOVER_BACKUP_DIR` in
   compose.env to that directory (mounted read-only into rab-api).
4. `docker compose pull && docker compose up -d`.

The cutover refuses to copy anything (`NO_BACKUP`; the affected workspaces answer 503) unless the backup is:
- at most 24 hours old by the database clock;
- of this database (name) and, when the login can read it, this cluster (`system_identifier`);
- re-hashed in full, with the exact size and sha256 the marker records.

Keep the backup until the release is accepted. Undoing the release after the cutover means restoring it, and every write
after the cutover is then lost.

## Behaviour changes for users

- None by design. Workspaces answer 503 "workspace is being upgraded" while the copy runs, for a few minutes after the
  upgrade starts.
- **Venue Manager apps: unusual clock-in confirmation** (PR #163). This applies only if #163 is merged before this release
  is cut. That is the owner's merge order (#149 → #150 → #163).
  - Correcting or recording a clock-in earlier than the staff member's own start minus 15 minutes (`CLOCK_IN_EARLY_MINUTES`)
    now needs an explicit Confirm in the app.
  - A clock-in more than 12 hours before the start (`CLOCK_IN_CONFIRM_FLOOR_HOURS`) is always refused.
  - Confirmed times show "Unusual time confirmed" on the shift report row.
  - **Older app versions** cannot send the confirmation, so they cannot save an unusually early clock-in. They show "This
    time is earlier than the normal allowance. Please check before continuing." Normal corrections and records work as
    before on every version.
  - What to tell Venue Managers: update the app to correct or record an unusually early clock-in.
  - Full note: `packages/rab-iphone/docs/RELEASE_NOTES.md` (added by #163).

## Not in 0.7.0 (separate decisions)

- C3 Q3, `VALIDATE staff_profile_workspace_required`, as workspace structure level 23. It is a separate draft PR with new
  SQL for the owner. If it is approved and merged before the release is cut, it runs in this release, after the cutover.
- The cost-measurement stack stays HWS off until it is re-measured (`production-parity.selftest.ts` ALLOWED entry).
