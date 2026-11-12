import { CommandRunner, Option } from 'nest-commander';

import { OPS_ACTOR_SOURCES, OpsLabelFlags } from './ops-run';

/**
 * Phase X2.2: the base class of the three ops commands. It declares the operator label flags once (nest-commander reads
 * @Option methods from the prototype chain, the same way Twenty declares shared command options on an abstract
 * CommandRunner). On the owner-login path the label is REQUIRED and comes only from these flags; in the separated-mode ops
 * container it comes from the container variables and the flags are refused (ops-run.ts assertOpsRun).
 *
 * The parsers only pass the raw value through: every rule (required, allowed sources, character set, length) is enforced
 * in one place, ops-run.ts validateOpsLabel, the same as for the container variables.
 */
export abstract class OpsCommandRunner extends CommandRunner {
  @Option({ flags: '--operator-source <source>', description: `operator label, required: who launched the run (${OPS_ACTOR_SOURCES.join(' | ')})` })
  parseOperatorSource(value: string): string {
    return value;
  }

  @Option({ flags: '--operator-id <id>', description: 'operator label, required: the CI OIDC subject, run id or deploy user (recorded, not verified)' })
  parseOperatorId(value: string): string {
    return value;
  }

  @Option({ flags: '--change-ref <ref>', description: 'operator label, required: the approved ticket / PR / change reference' })
  parseChangeRef(value: string): string {
    return value;
  }
}

/** The label flags out of a command's parsed options (nothing else is read). */
export function opsLabelFlagsOf(options: OpsLabelFlags | undefined): OpsLabelFlags {
  return { operatorSource: options?.operatorSource, operatorId: options?.operatorId, changeRef: options?.changeRef };
}
