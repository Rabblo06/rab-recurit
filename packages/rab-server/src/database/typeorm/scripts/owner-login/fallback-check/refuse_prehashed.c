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
 *   - with refuse_prehashed.refuse_passwordless_login = on (SIGHUP; off by default): ProcessUtility_hook remembers a
 *     CREATE ROLE / CREATE USER that makes a LOGIN role WITHOUT a PASSWORD option (the case a provider may refuse);
 *   - XACT_EVENT_PRE_COMMIT: if any of those was seen, ERROR (XX000) with a fixed message; the transaction aborts;
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
#include "nodes/parsenodes.h"
#include "nodes/value.h"
#include "tcop/utility.h"
#include "utils/guc.h"

PG_MODULE_MAGIC;

void _PG_init(void);

static check_password_hook_type prev_check_password_hook = NULL;
static ProcessUtility_hook_type prev_process_utility = NULL;
static bool refuse_passwordless_login = false;
static bool prehashed_seen = false;
static bool weak_seen = false;
static bool passwordless_seen = false;

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
refuse_prehashed_utility(PlannedStmt *pstmt, const char *queryString, bool readOnlyTree, ProcessUtilityContext context,
						 ParamListInfo params, QueryEnvironment *queryEnv, DestReceiver *dest, QueryCompletion *qc)
{
	Node	   *parsetree = pstmt->utilityStmt;

	if (refuse_passwordless_login && IsA(parsetree, CreateRoleStmt))
	{
		CreateRoleStmt *stmt = (CreateRoleStmt *) parsetree;
		bool		login = (stmt->stmt_type == ROLESTMT_USER);
		bool		password = false;
		ListCell   *lc;

		foreach(lc, stmt->options)
		{
			DefElem    *d = (DefElem *) lfirst(lc);

			if (strcmp(d->defname, "canlogin") == 0)
				login = boolVal(d->arg);
			else if (strcmp(d->defname, "password") == 0 && d->arg != NULL)
				password = true;
		}
		if (login && !password)
			passwordless_seen = true;
	}
	if (prev_process_utility)
		prev_process_utility(pstmt, queryString, readOnlyTree, context, params, queryEnv, dest, qc);
	else
		standard_ProcessUtility(pstmt, queryString, readOnlyTree, context, params, queryEnv, dest, qc);
}

static void
refuse_prehashed_xact(XactEvent event, void *arg)
{
	if (event == XACT_EVENT_PRE_COMMIT || event == XACT_EVENT_PARALLEL_PRE_COMMIT)
	{
		if (prehashed_seen || weak_seen || passwordless_seen)
		{
			const char *why = prehashed_seen ? "simulated refusal: role passwords must be supplied in plain text"
				: passwordless_seen ? "simulated refusal: a login role needs a password"
				: "simulated refusal: the role password is too weak";

			prehashed_seen = false;
			weak_seen = false;
			passwordless_seen = false;
			elog(ERROR, "%s", why);
		}
	}
	else if (event == XACT_EVENT_COMMIT || event == XACT_EVENT_ABORT || event == XACT_EVENT_PARALLEL_COMMIT ||
			 event == XACT_EVENT_PARALLEL_ABORT)
	{
		prehashed_seen = false;
		weak_seen = false;
		passwordless_seen = false;
	}
}

void
_PG_init(void)
{
	DefineCustomBoolVariable("refuse_prehashed.refuse_passwordless_login",
							 "Also refuse a LOGIN role created without a password (test simulator only).",
							 NULL, &refuse_passwordless_login, false, PGC_SIGHUP, 0, NULL, NULL, NULL);
	prev_check_password_hook = check_password_hook;
	check_password_hook = refuse_prehashed_check_password;
	prev_process_utility = ProcessUtility_hook;
	ProcessUtility_hook = refuse_prehashed_utility;
	RegisterXactCallback(refuse_prehashed_xact, NULL);
}
