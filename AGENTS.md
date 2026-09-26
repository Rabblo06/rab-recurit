# Session workflow

Before modifying code:
1. Read `docs/HANDOFF.md` completely and the working agreements in `CLAUDE.md`.
2. Inspect git status/diff and preserve existing work.
3. Verify the handoff against current code; code and fresh evidence outrank stale documentation.
4. Continue relevant documented pending work within the user's current scope.

At the end of every substantial coding task, update the same `docs/HANDOFF.md`: date, changes, decisions, verification results, remaining issues and next action. When adding an important production component/module, check whether the handoff needs updating. Never store credentials, tokens, personal data or secret values there.
