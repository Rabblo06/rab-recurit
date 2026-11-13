/**
 * Side-effect module, imported by command/main.ts BEFORE the command module graph: declares the CLI's process role (`cli`)
 * before any import-time code resolves the database configuration (ConfigModule.forRoot validates the environment while
 * command.module is being imported). Without this, that early validation would resolve as the default `api` role.
 * There is no other CLI role: the separated-mode `ops` role of the removed rab-ops container is gone, and every process,
 * the CLI included, refuses its variables (pg-config.ts assertNoRetiredOpsEnv). The ops placement rules (owner login only)
 * run in main.ts's bootstrap() (ops-run.ts assertOpsPlacement).
 */
import { setPgProcessRole } from '../../database/postgres/pg-config';

setPgProcessRole('cli');
