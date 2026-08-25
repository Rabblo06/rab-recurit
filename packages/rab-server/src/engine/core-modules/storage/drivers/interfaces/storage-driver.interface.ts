export interface StorageDriverInterface {
  write(key: string, buffer: Buffer): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}
