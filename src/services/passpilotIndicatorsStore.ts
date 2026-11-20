import crypto from "node:crypto";
import { z } from "zod";

export const INDICATOR_PAIRING_TTL_SECONDS = 30 * 86_400;
const TOKEN_PATTERN = /^ppi_[A-Za-z0-9_-]{43}$/;
const identifier = z.string().min(1).max(128);
const classScope = z.object({
  classId: identifier,
  classSource: z.enum(["legacy_grades", "classpilot_groups"]),
});
const kioskScope = z.object({
  kioskDeviceId: identifier,
  kioskBindingGeneration: z.string().regex(/^\d{1,16}\.\d{6}$/),
});
const ownerScope = z.object({
  schoolId: identifier,
  userId: identifier,
  waterCustomDestination: z.string().min(1).max(200).optional(),
});
const pairingHeader = {
  version: z.literal(1),
  pairingId: z.string().uuid(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  schoolId: ownerScope.shape.schoolId,
  userId: ownerScope.shape.userId,
};
const pairingTail = {
  waterCustomDestination: ownerScope.shape.waterCustomDestination,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
};
// Preserve the v1 class record's field order for Redis compare-and-delete.
const pairingSchema = z.union([
  z.object({ ...pairingHeader, ...classScope.shape, ...pairingTail }).strict(),
  z.object({ ...pairingHeader, ...kioskScope.shape, ...pairingTail }).strict(),
]);

export type IndicatorPairing = z.infer<typeof pairingSchema>;
export type IndicatorKioskTarget = z.infer<typeof kioskScope>;
export type IndicatorClassSource = z.infer<typeof classScope>["classSource"];
export type IndicatorPairingScope = z.infer<typeof ownerScope> & (z.infer<typeof classScope> | IndicatorKioskTarget);

export function indicatorError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function unavailable(): Error {
  return indicatorError(503, "PASSPILOT_INDICATOR_UNAVAILABLE", "Indicator service unavailable");
}

// Both keys are created together, with an independent pairing ID for revocation.
const ISSUE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1`;
const REVOKE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2])
return 1`;

type StoreOptions = {
  now?: () => number;
  redisConfigured?: () => boolean;
  production?: () => boolean;
  redis?: (args: string[]) => Promise<unknown>;
  maxLocalEntries?: number;
};

/** Redis is authoritative when configured; local state is development-only. */
export class PasspilotIndicatorStore {
  private readonly local = new Map<string, IndicatorPairing>();
  private readonly localTokens = new Map<string, string>();
  private readonly now: () => number;
  private readonly redisConfigured: () => boolean;
  private readonly production: () => boolean;
  private readonly redis: (args: string[]) => Promise<unknown>;
  private readonly maxLocalEntries: number;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.redisConfigured = options.redisConfigured ?? (() => Boolean(process.env.REDIS_URL));
    this.production = options.production ?? (() => process.env.NODE_ENV === "production");
    this.redis = options.redis ?? (async (args) => {
      const { redisCommand } = await import("../middleware/rateLimiter.js");
      return redisCommand(args, { readyTimeoutMs: 500 });
    });
    this.maxLocalEntries = options.maxLocalEntries ?? 256;
    if (!Number.isSafeInteger(this.maxLocalEntries) || this.maxLocalEntries < 1) throw new Error("Invalid indicator store bound");
  }

  private key(kind: "pairing" | "token", id: string): string {
    return `${process.env.REDIS_PREFIX ?? "schoolpilot"}:passpilot:indicator:v1:${kind}:${id}`;
  }

  private async command(args: string[]): Promise<unknown> {
    try {
      const value = await this.redis(args);
      if (value === undefined) throw unavailable();
      return value;
    } catch {
      throw unavailable();
    }
  }

  private checkLocalAllowed(): void {
    if (this.production()) throw unavailable();
  }

  private prune(): void {
    for (const record of this.local.values()) {
      if (record.expiresAt <= this.now()) this.deleteLocal(record);
    }
  }

  private deleteLocal(record: IndicatorPairing): void {
    this.local.delete(record.pairingId);
    this.localTokens.delete(record.tokenHash);
  }

  private parse(raw: unknown): IndicatorPairing | null {
    if (raw === null) return null;
    if (typeof raw !== "string" || raw.length > 2048) throw unavailable();
    try {
      const record = pairingSchema.parse(JSON.parse(raw));
      if (record.expiresAt - record.issuedAt !== INDICATOR_PAIRING_TTL_SECONDS * 1000 || record.issuedAt > this.now()) throw unavailable();
      return record.expiresAt > this.now() ? record : null;
    } catch {
      throw unavailable();
    }
  }

  async issue(scope: IndicatorPairingScope): Promise<{ token: string; record: IndicatorPairing }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = `ppi_${crypto.randomBytes(32).toString("base64url")}`;
      const issuedAt = this.now();
      const record = pairingSchema.parse({
        ...scope, version: 1, pairingId: crypto.randomUUID(),
        tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
        issuedAt, expiresAt: issuedAt + INDICATOR_PAIRING_TTL_SECONDS * 1000,
      });
      if (this.redisConfigured()) {
        const result = await this.command(["EVAL", ISSUE_SCRIPT, "2", this.key("pairing", record.pairingId), this.key("token", record.tokenHash), JSON.stringify(record), record.pairingId, String(INDICATOR_PAIRING_TTL_SECONDS)]);
        if (result === 0) continue;
        if (result !== 1) throw unavailable();
      } else {
        this.checkLocalAllowed();
        this.prune();
        while (this.local.size >= this.maxLocalEntries) this.deleteLocal(this.local.values().next().value!);
        this.local.set(record.pairingId, record);
        this.localTokens.set(record.tokenHash, record.pairingId);
      }
      return { token, record };
    }
    throw unavailable();
  }

  private async findById(pairingId: string): Promise<IndicatorPairing | null> {
    if (!z.string().uuid().safeParse(pairingId).success) return null;
    if (this.redisConfigured()) return this.parse(await this.command(["GET", this.key("pairing", pairingId)]));
    this.checkLocalAllowed();
    this.prune();
    return this.local.get(pairingId) ?? null;
  }

  async findByToken(token: string): Promise<IndicatorPairing | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const digest = crypto.createHash("sha256").update(token).digest("hex");
    let pairingId: unknown;
    if (this.redisConfigured()) pairingId = await this.command(["GET", this.key("token", digest)]);
    else {
      this.checkLocalAllowed();
      this.prune();
      pairingId = this.localTokens.get(digest) ?? null;
    }
    if (pairingId === null) return null;
    if (typeof pairingId !== "string" || !z.string().uuid().safeParse(pairingId).success) throw unavailable();
    const record = await this.findById(pairingId);
    return record && record.pairingId === pairingId && record.tokenHash === digest ? record : null;
  }

  async revoke(pairingId: string, schoolId: string, userId: string): Promise<boolean> {
    const record = await this.findById(pairingId);
    if (!record || record.schoolId !== schoolId || record.userId !== userId) return false;
    if (this.redisConfigured()) {
      const result = await this.command(["EVAL", REVOKE_SCRIPT, "2", this.key("pairing", pairingId), this.key("token", record.tokenHash), JSON.stringify(record)]);
      if (result !== 0 && result !== 1) throw unavailable();
      return result === 1;
    }
    this.deleteLocal(record);
    return true;
  }
}
