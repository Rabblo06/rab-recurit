import { STAGE, type PayrollStage } from './payrollModel';

export function StagePill({ stage, compact = false }: { stage: PayrollStage; compact?: boolean }) {
  const s = STAGE[stage];
  return <span className={`payroll-pill tone-${s.tone}${compact ? ' is-compact' : ''}`}>{s.label}</span>;
}
