-- Run only against a seeded disposable test database after AdminMemberDirectory migration.
-- Requires a migration/test owner able to SET ROLE crewflow_app; all work rolls back.
\set ON_ERROR_STOP on
BEGIN;
DO $test$
DECLARE admin_id uuid; member_id uuid; org_id uuid; ws_id uuid; result jsonb; next_page jsonb; expected bigint;
BEGIN
 SELECT p.user_id INTO admin_id FROM core.platform_admin p JOIN core."user" u ON u.id=p.user_id WHERE p.revoked_at IS NULL AND u.status='active' AND u.deleted_at IS NULL LIMIT 1;
 SELECT m.user_id,m.organisation_id,m.workspace_id INTO member_id,org_id,ws_id FROM core.workspace_membership m JOIN core."user" u ON u.id=m.user_id WHERE m.status='active' AND u.status='active' AND u.deleted_at IS NULL AND NOT core.is_active_platform_admin(u.id) LIMIT 1;
 IF admin_id IS NULL OR member_id IS NULL THEN RAISE EXCEPTION 'Missing test fixtures'; END IF;
 SELECT count(*) INTO expected FROM core."user" WHERE deleted_at IS NULL;
 PERFORM set_config('rab.user_id','',true);
 SET LOCAL ROLE crewflow_app;
 BEGIN PERFORM core.admin_member_directory('',1,25); RAISE EXCEPTION 'No-context admin call allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM core.workspace_member_directory('',1,25); RAISE EXCEPTION 'No-context workspace call allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('rab.user_id',member_id::text,true);
 PERFORM set_config('rab.organisation_id',org_id::text,true);
 PERFORM set_config('rab.workspace_id',ws_id::text,true);
 BEGIN PERFORM core.admin_member_directory('',1,25); RAISE EXCEPTION 'Nonadmin directory allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 result:=core.workspace_member_directory('',1,100);
 IF (result->>'total')::int < 1 THEN RAISE EXCEPTION 'Workspace directory empty'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(result->'data') r CROSS JOIN LATERAL jsonb_object_keys(r) k WHERE k NOT IN ('userId','firstName','lastName','email')) THEN RAISE EXCEPTION 'Private fields leaked'; END IF;
 RESET ROLE;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(result->'data') r WHERE NOT EXISTS(SELECT 1 FROM core.workspace_membership m WHERE m.user_id=(r->>'userId')::uuid AND m.organisation_id=org_id AND m.workspace_id=ws_id)) THEN RAISE EXCEPTION 'Workspace leakage'; END IF;
 PERFORM set_config('rab.workspace_id',gen_random_uuid()::text,true);
 SET LOCAL ROLE crewflow_app;
 BEGIN PERFORM core.workspace_member_directory('',1,25); RAISE EXCEPTION 'Foreign workspace allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('rab.user_id',admin_id::text,true);
 result:=core.admin_member_directory('',1,25);
 next_page:=core.admin_member_directory('',2,25);
 IF (result->>'total')::bigint < expected THEN RAISE EXCEPTION 'Crossorg accounts missing'; END IF;
 IF jsonb_array_length(result->'data')<>25 THEN RAISE EXCEPTION 'Page limit broken'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(result->'data') a JOIN jsonb_array_elements(next_page->'data') b ON a->>'id'=b->>'id') THEN RAISE EXCEPTION 'Overlapping pages'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(result->'data') r CROSS JOIN LATERAL jsonb_object_keys(r) k WHERE k NOT IN ('id','userId','kind','firstName','lastName','email','status','organisationName','expiresAt')) THEN RAISE EXCEPTION 'Admin private fields leaked'; END IF;
 BEGIN PERFORM core.admin_member_directory('',0,25); RAISE EXCEPTION 'Invalid page allowed'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM core.admin_member_directory('',1,101); RAISE EXCEPTION 'Oversized page allowed'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF (core.admin_member_directory('no-match-unique-directory-fixture',1,25)->>'total')::int<>0 THEN RAISE EXCEPTION 'Search failed'; END IF;
 RAISE NOTICE 'PASS: no context, nonadmin, workspace isolation, safe fields, crossorg listing, pagination, validation, search';
END $test$;
ROLLBACK;