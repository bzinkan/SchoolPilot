export type ReadProbePhase = 'warmup' | 'baseline' | 'uploading' | 'preparing' | 'continuations' | 'cleanup';
export const CAPACITY_READ_PATHS: readonly string[];
export const CAPACITY_MEASUREMENT_PLAN: Readonly<{
  warmupMinimumMs: number; warmupSamplesPerEndpoint: number;
  baselineMinimumMs: number; baselineSamplesPerEndpoint: number;
  loadedSamplesPerEndpoint: number; sampleCadenceMs: number;
  p95Multiplier: number; stopWindowSamples: number; stopConsecutiveWindows: number; postWorkPadding: boolean;
}>;
export function samplingPhaseComplete(phase: 'warmup' | 'baseline' | 'loaded', elapsedMs: number,
  countsByEndpoint: Record<string, number>): boolean;
export function loadedProbesWithinWork(samples: ReadProbeSample[], startedAtMs: number, completedAtMs: number): boolean;
export interface ReadProbeSample {
  id?: number;
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
  context: { id?: number; path: string; phase: ReadProbePhase }, operation: () => Promise<T>,
  clock?: { now: () => number; originMs: number }): Promise<{ response: T; durationMs: number }>;
