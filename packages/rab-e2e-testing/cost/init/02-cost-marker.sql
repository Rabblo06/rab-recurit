-- Disposable cost stack only: the marker every harness script checks before writing (lib/common.sh assert_disposable),
-- so it can only ever write to THIS disposable cluster. Runs once at initdb, after 01-crewflow-owner.sql.
COMMENT ON DATABASE rab IS 'crewflow-cost disposable measurement database';
