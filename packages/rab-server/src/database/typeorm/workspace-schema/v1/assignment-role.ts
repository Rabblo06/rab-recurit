/** Append-only workspace module 18. Historical assignments retain their parent role. */
export function assignmentRoleSql(schema: string): string {
  if (schema !== 'core' && !/^workspace_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid workspace schema');
  return `ALTER TABLE "${schema}".shift_assignment
    ADD COLUMN job_role_id uuid NULL,
    ADD COLUMN pay_rate_override_pence bigint NULL,
    ADD CONSTRAINT shift_assignment_role_fk FOREIGN KEY (job_role_id) REFERENCES "${schema}".job_role(id) ON DELETE RESTRICT,
    ADD CONSTRAINT shift_assignment_rate_override_check CHECK (pay_rate_override_pence IS NULL OR (job_role_id IS NOT NULL AND pay_rate_override_pence >= 0));`;
}
