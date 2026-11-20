import { z } from "zod";
import type { AuditEntry } from "./audit.js";
import { indicatorError, type IndicatorClassSource, type IndicatorKioskTarget, type IndicatorPairing, type PasspilotIndicatorStore } from "./passpilotIndicatorsStore.js";

const targetId = z.string().trim().min(1).max(128);
const waterCustomDestination = z.string().min(1).max(200).refine((value) => value.trim().length > 0).optional();
export const indicatorPairingRequestSchema = z.union([
  z.object({ classId: targetId, waterCustomDestination }).strict(),
  z.object({ kioskSessionId: targetId, waterCustomDestination }).strict(),
]);

type Owner = { schoolId: string; userId: string };
export type { IndicatorKioskTarget } from "./passpilotIndicatorsStore.js";
export type IndicatorKioskOption = { kioskSessionId: string; className: string | null; lastSeenAt: string };
export type IndicatorAuthority = {
  schoolActive: boolean;
  licensed: boolean;
  staffActive: boolean;
  classActive: boolean;
  classAuthorized: boolean;
  classSource: IndicatorClassSource;
};
type Dependencies = {
  store: PasspilotIndicatorStore;
  loadAuthority: (scope: Owner & { classId?: string }) => Promise<IndicatorAuthority>;
  listKiosks: (owner: Owner) => Promise<IndicatorKioskOption[]>;
  resolveKioskTarget: (owner: Owner, kioskSessionId: string) => Promise<IndicatorKioskTarget | null>;
  withSchoolContext: <T>(schoolId: string, fn: () => Promise<T>) => Promise<T>;
  loadMask: (pairing: IndicatorPairing) => Promise<number | null>;
  audit: (entry: AuditEntry) => Promise<void>;
};

function unavailableAuthority() {
  return indicatorError(403, "PASSPILOT_INDICATOR_AUTHORITY_UNAVAILABLE", "Indicator authority is unavailable. Check access and pair again.");
}

function requireAccountAuthority(authority: IndicatorAuthority): void {
  if (!authority.schoolActive || !authority.licensed || !authority.staffActive) throw unavailableAuthority();
}

function requireClassAuthority(authority: IndicatorAuthority, expectedSource = authority.classSource): void {
  if (!authority.classActive || !authority.classAuthorized || authority.classSource !== expectedSource) {
    throw unavailableAuthority();
  }
}

export function createPasspilotIndicatorService(dependencies: Dependencies) {
  return {
    async listKiosks(owner: Owner) {
      requireAccountAuthority(await dependencies.loadAuthority(owner));
      return dependencies.listKiosks(owner);
    },
    async pair(owner: Owner, input: z.infer<typeof indicatorPairingRequestSchema>) {
      const parsed = indicatorPairingRequestSchema.parse(input);
      const classScope = "classId" in parsed ? { classId: parsed.classId } : undefined;
      const authority = await dependencies.loadAuthority({ ...owner, ...classScope });
      requireAccountAuthority(authority);
      const target = "kioskSessionId" in parsed
        ? await dependencies.resolveKioskTarget(owner, parsed.kioskSessionId)
        : { classId: parsed.classId, classSource: authority.classSource };
      if (!target) throw unavailableAuthority();
      if ("classId" in target) requireClassAuthority(authority);
      const issued = await dependencies.store.issue({ ...owner, ...target, waterCustomDestination: parsed.waterCustomDestination });
      const expiresAt = new Date(issued.record.expiresAt).toISOString();
      try {
        await dependencies.audit({
          ...owner, action: "passpilot.indicator.paired", entityType: "passpilot_indicator", entityId: issued.record.pairingId,
          metadata: { ...("classId" in target ? target : { targetType: "kiosk" }), expiresAt },
        });
      } catch (error) {
        await dependencies.store.revoke(issued.record.pairingId, owner.schoolId, owner.userId);
        throw error;
      }
      return { pairingId: issued.record.pairingId, token: issued.token, expiresAt };
    },
    async state(token: string) {
      const pairing = await dependencies.store.findByToken(token);
      if (!pairing) throw indicatorError(401, "PASSPILOT_INDICATOR_TOKEN_INVALID", "Invalid or expired indicator credential");
      return dependencies.withSchoolContext(pairing.schoolId, async () => {
        const owner = { schoolId: pairing.schoolId, userId: pairing.userId };
        const classScope = "classId" in pairing ? { classId: pairing.classId } : undefined;
        const authority = await dependencies.loadAuthority({ ...owner, ...classScope });
        requireAccountAuthority(authority);
        if ("classSource" in pairing) requireClassAuthority(authority, pairing.classSource);
        const mask = await dependencies.loadMask(pairing);
        if (mask === null) throw unavailableAuthority();
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
