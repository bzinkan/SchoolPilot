export interface StorageSample {
  operation: 'put' | 'get' | 'delete';
  startedAtMs: number;
  durationMs: number;
  bytes: number;
  succeeded: boolean;
  errorCode: string | null;
}
export interface StorageEvidence {
  version: number;
  implementation: string;
  maxSamples: number;
  operationCount: number;
  samples: StorageSample[];
}
export function createStorageEvidence(): StorageEvidence;
export function createPhysicalObjectStore(directory: string, evidence: StorageEvidence, originMs?: number): Promise<{
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}>;
