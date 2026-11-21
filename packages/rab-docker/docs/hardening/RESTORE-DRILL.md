# M9 restore drill (InstaBox ibox2, 2026-11-21)

Lane F hardening evidence. A rehearsal of `docs/release/MIGRATION-AND-ROLLBACK-PLAN.md` §5 on a disposable host: back up
a seeded, production-shaped database, restore it into a fresh cluster, prove the security posture survived, and run the
application on the copy. Script: `packages/rab-e2e-testing/system/perf/stack/restore-drill.sh`. Never production, never a
shared database: every resource was a `crewtest-lanef-*` container or directory on ibox2, removed afterwards by name.

<!-- RESULTS -->
