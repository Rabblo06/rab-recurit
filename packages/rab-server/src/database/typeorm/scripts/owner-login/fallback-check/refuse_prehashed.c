/*
 * refuse_prehashed: a TEST-ONLY PostgreSQL extension (never shipped, never loaded outside the disposable InstaBox cluster of
 * run-fallback-check.sh). It SIMULATES a managed PostgreSQL server that refuses pre-hashed role passwords, the way the
 * production failure of 2026-11-19 behaved: the CREATE / ALTER ROLE statement itself succeeds, and the refusal comes at
 * COMMIT, as an elog(ERROR) (SQLSTATE XX000, internal_error) raised from a pre-commit transaction callback.
 *
 * What it does, and nothing else:
 *   - check_password_hook: remembers, for the current transaction, that a role password arrived PRE-HASHED (a SCRAM-SHA-256
 *     verifier or an md5 hash: password_type is not PASSWORD_TYPE_PLAINTEXT), or arrived in plain text shorter than 12
 *     characters (a crude strength rule);
 *   - XACT_EVENT_PRE_COMMIT: if either was seen, ERROR (XX000) with a fixed message; the transaction aborts;
 *   - every other transaction end clears the flags.
 * It never stores, logs or forwards a password. What it does NOT simulate: any network call, any provider-side storage of
 * the password, and an entropy estimator (only the length rule above). Honest scope: it reproduces the SQLSTATE and the
 * stage (COMMIT) of the refusal, which is all db-setup's classification reads.
 */
#include "postgres.h"

#include "access/xact.h"
#include "commands/user.h"
#include "fmgr.h"
#include "libpq/crypt.h"

PG_MODULE_MAGIC;

void _PG_init(void);

static check_password_hook_type prev_check_password_hook = NULL;
static bool prehashed_seen = false;
static bool weak_seen = false;

static void
refuse_prehashed_check_password(const char *username, const char *shadow_pass, PasswordType password_type,
								Datum validuntil_time, bool validuntil_null)
{
	if (prev_check_password_hook)
		prev_check_password_hook(username, shadow_pass, password_type, validuntil_time, validuntil_null);
	if (password_type != PASSWORD_TYPE_PLAINTEXT)
		prehashed_seen = true;
	else if (strlen(shadow_pass) < 12)
		weak_seen = true;
}

static void
refuse_prehashed_xact(XactEvent event, void *arg)
{
	if (event == XACT_EVENT_PRE_COMMIT || event == XACT_EVENT_PARALLEL_PRE_COMMIT)
	{
		if (prehashed_seen || weak_seen)
		{
			bool		prehashed = prehashed_seen;

			prehashed_seen = false;
			weak_seen = false;
			elog(ERROR, "%s", prehashed ? "simulated refusal: role passwords must be supplied in plain text"
				 : "simulated refusal: the role password is too weak");
		}
	}
	else if (event == XACT_EVENT_COMMIT || event == XACT_EVENT_ABORT || event == XACT_EVENT_PARALLEL_COMMIT ||
			 event == XACT_EVENT_PARALLEL_ABORT)
	{
		prehashed_seen = false;
		weak_seen = false;
	}
}

void
_PG_init(void)
{
	prev_check_password_hook = check_password_hook;
	check_password_hook = refuse_prehashed_check_password;
	RegisterXactCallback(refuse_prehashed_xact, NULL);
}
