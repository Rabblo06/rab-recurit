export const StorageDriver = {
  LOCAL: 'LOCAL',
  S3: 'S3',
} as const;

export type StorageDriverType = (typeof StorageDriver)[keyof typeof StorageDriver];
