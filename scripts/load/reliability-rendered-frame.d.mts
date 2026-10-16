export function stampReliabilityFrame(fixture: string, capturedAt: number, ordinal: number): string;
export function readReliabilityFrame(source: unknown): { capturedAt: number; ordinal: number } | null;
export function initialReliabilityCommandBurst<T>(bodies: T[], send: (body: T, index: number) => Promise<unknown>): Promise<void>;
