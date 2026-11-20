import { z } from "zod";
import type { AuditEntry } from "./audit.js";
import { indicatorError, type IndicatorPairing, type PasspilotIndicatorStore } from "./passpilotIndicatorsStore.js";

export const indicatorPairingRequestSchema = z.object({
  classId: z.string().trim().min(1).max(128),
  waterCustomDestination: z.string().min(1).max(200).refine((value) => value.trim().length > 0).optional(),
}).strict();

type Scope = { schoolId: string; userId: string; classId: string };
type Owner = Omit<Scope, "classId">;
export type IndicatorAuthority = {
  schoolActive: boolean;
  licensed: boolean;
  staffActive: boolean;
  classActive: boolean;
  classAuthorized: boolean;
  classSource: IndicatorPairing["classSource"];
};
type Dependencies = {
  store: PasspilotIndicatorStore;
  loadAuthority: (scope: Scope) => Promise<IndicatorAuthority>;
  withSchoolContext: <T>(schoolId: string, fn: () => Promise<T>) => Promise<T>;
  loadMask: (pairing: IndicatorPairing) => Promise<number>;
  audit: (entry: AuditEntry) => Promise<void>;
};

function requireAuthority(authority: IndicatorAuthority, expectedSource?: IndicatorPairing["classSource"]): void {
  if (!authority.schoolActive || !authority.licensed || !authority.staffActive || !authority.classActive || !authority.classAuthorized || expectedSource && authority.classSource !== expectedSource) {
    throw indicatorError(403, "PASSPILOT_INDICATOR_AUTHORITY_UNAVAILABLE", "Indicator authority is unavailable; check access and pair again");
  }
}

export function createPasspilotIndicatorService(dependencies: Dependencies) {
  return {
    async pair(owner: Owner, input: z.infer<typeof indicatorPairingRequestSchema>) {
      const parsed = indicatorPairingRequestSchema.parse(input);
      const authority = await dependencies.loadAuthority({ ...owner, classId: parsed.classId });
      requireAuthority(authority);
      const issued = await dependencies.store.issue({ ...owner, ...parsed, classSource: authority.classSource });
      try {
        await dependencies.audit({
          ...owner, action: "passpilot.indicator.paired", entityType: "passpilot_indicator", entityId: issued.record.pairingId,
          metadata: { classId: parsed.classId, classSource: authority.classSource, expiresAt: new Date(issued.record.expiresAt).toISOString() },
        });
      } catch (error) {
        await dependencies.store.revoke(issued.record.pairingId, owner.schoolId, owner.userId);
        throw error;
      }
      return { pairingId: issued.record.pairingId, token: issued.token, expiresAt: new Date(issued.record.expiresAt).toISOString() };
    },
    async state(token: string) {
      const pairing = await dependencies.store.findByToken(token);
      if (!pairing) throw indicatorError(401, "PASSPILOT_INDICATOR_TOKEN_INVALID", "Invalid or expired indicator credential");
      return dependencies.withSchoolContext(pairing.schoolId, async () => {
        const authority = await dependencies.loadAuthority({ schoolId: pairing.schoolId, userId: pairing.userId, classId: pairing.classId });
        requireAuthority(authority, pairing.classSource);
        const mask = await dependencies.loadMask(pairing);
        if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw indicatorError(503, "PASSPILOT_INDICATOR_UNAVAILABLE", "Indicator service unavailable");
        return { version: 1 as const, mask, maxAgeSeconds: 30 as const };
      });
    },
    async revoke(owner: Owner, pairingId: string) {
      if (!await dependencies.store.revoke(pairingId, owner.schoolId, owner.userId)) return false;
      await dependencies.audit({ ...owner, action: "passpilot.indicator.revoked", entityType: "passpilot_indicator", entityId: pairingId });
      return true;
    },
  };
}

export type PasspilotIndicatorService = ReturnType<typeof createPasspilotIndicatorService>;
