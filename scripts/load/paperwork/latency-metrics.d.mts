export type ReadProbePhase = 'warmup' | 'baseline' | 'uploading' | 'preparing' | 'continuations' | 'cleanup';
export interface ReadProbeSample {
  path: string;
  phase: ReadProbePhase;
  startedAtMs: number;
  durationMs: number;
  status: number | null;
}
export interface ReadProbeEvidence {
  version: number;
  measurement: string;
  percentileMethod: string;
  maxSamples: number;
  samples: ReadProbeSample[];
}
export function nearestRankPercentile(values: number[], quantile: number): number | null;
export function createReadProbeEvidence(): ReadProbeEvidence;
export function recordReadProbe(evidence: ReadProbeEvidence, sample: ReadProbeSample): void;
export function measureReadProbe<T extends { status: number }>(evidence: ReadProbeEvidence,
  context: { path: string; phase: ReadProbePhase }, operation: () => Promise<T>,
  clock?: { now: () => number; originMs: number }): Promise<{ response: T; durationMs: number }>;
