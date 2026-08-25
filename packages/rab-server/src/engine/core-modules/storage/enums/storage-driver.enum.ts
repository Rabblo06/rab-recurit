export const StorageDriver = {
  LOCAL: 'LOCAL',
} as const;

export type StorageDriverType = (typeof StorageDriver)[keyof typeof StorageDriver];
