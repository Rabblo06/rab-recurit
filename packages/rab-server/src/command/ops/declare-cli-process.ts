/**
 * Side-effect module, imported by command/main.ts BEFORE the command module graph: declares the CLI's process role (`ops`
 * inside the one-off operations container, else `cli`) before any import-time code resolves the database configuration
 * (ConfigModule.forRoot validates the environment while command.module is being imported). Without this, that early
 * validation would resolve as the default `api` role and — correctly — refuse every ops variable.
 * The placement rules themselves (ops commands only in the ops container and vice versa) run in main.ts's bootstrap().
 */
import { setPgProcessRole } from '../../database/postgres/pg-config';
import { cliProcessRoleFor } from './ops-run';

setPgProcessRole(cliProcessRoleFor(process.env));
