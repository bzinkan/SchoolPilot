export type TaskDefinition = {
  containerDefinitions?: Array<{
    name: string;
    image?: string;
    environment?: Array<{ name: string; value: string }>;
    secrets?: Array<{ name: string; valueFrom: string }>;
  }>;
};
export type CandidateSources = { registry: string; writer: string; migration: string; protocol: string };
export function assertPrivateChatReleaseFloor(input: {
  apiTaskDefinition: TaskDefinition;
  workerTaskDefinition: TaskDefinition;
  enablingTables?: string[];
  candidateSources: CandidateSources | null;
  rollbackSourcesBySha?: Record<string, Pick<CandidateSources, 'writer' | 'migration' | 'protocol'>>;
  candidateTaskDefinitions?: Array<{ taskDefinition: TaskDefinition; containerName: string }>;
}): { required: false } | { required: true; writerVersion: 1; inventoryCount: 129 };
export function verifyPrivateChatSourceImages(input: {
  apiTaskDefinition: TaskDefinition;
  workerTaskDefinition: TaskDefinition;
  expectedRepository: string;
  lookupDigest: (tag: string) => string;
}): true;
