export const HealthStatus = {
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  DOWN: 'down',
  UNKNOWN: 'unknown',
} as const;

export type HealthStatusType = (typeof HealthStatus)[keyof typeof HealthStatus];
