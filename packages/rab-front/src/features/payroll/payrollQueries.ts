import { queryOptions } from '@tanstack/react-query';
import { api } from '../../shared/api';
import type { PayrollPeriod } from './payrollModel';

/**
 * The month's payroll period (`GET /payroll/period`). Shared by `usePayroll` and the shell's nav-hover prefetch: one
 * definition, one cache key. Its own small module so the shell does not pull the Payroll page into the first-load bundle.
 */
export function payrollPeriodQuery(month: string) {
  return queryOptions({
    queryKey: ['payroll', 'period', month],
    queryFn: async () => (await api.get<PayrollPeriod>('/payroll/period', { params: { month } })).data,
  });
}
