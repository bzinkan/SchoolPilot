import type { RequestHandler, Response } from "express";
import { bindTenantContext } from "./tenantContext.js";
import { createSingleFlight } from "../util/singleFlight.js";
import {
  loadVerifiedSchoolIdentities,
  type VerifiedSchoolIdentity,
} from "../services/schoolIdentity.js";

const loadIdentitySingleFlight = createSingleFlight<
  string,
  VerifiedSchoolIdentity[]
>({ maxPendingKeys: 4_096 });

function loadIdentities(userId: string, schoolId?: string) {
  const key = `${userId}\u0000${schoolId ?? "*"}`;
  return loadIdentitySingleFlight(key, () =>
    loadVerifiedSchoolIdentities(userId, schoolId)
  );
}

let ambiguousSelectionCount = 0;
const ambiguousSelectionTimer = setInterval(() => {
  if (ambiguousSelectionCount === 0) return;
  console.warn(JSON.stringify({
    event: "ambiguous_school_selection",
    count: ambiguousSelectionCount,
    mode: membershipResolverMode(),
  }));
  ambiguousSelectionCount = 0;
}, 60_000);
ambiguousSelectionTimer.unref?.();

function membershipResolverMode(): "observe" | "enforce" {
  return process.env.MEMBERSHIP_RESOLVER_MODE?.toLowerCase() === "enforce"
    ? "enforce"
    : "observe";
}

function applyVerifiedIdentity(
  res: Response,
  identity: VerifiedSchoolIdentity
): void {
  res.locals.schoolId = identity.schoolId;
  res.locals.membershipRole = identity.primaryRole;
  res.locals.membershipRoles = identity.roles;
  res.locals.school = identity.school;
  res.locals.schoolIdentity = identity;
  res.locals.verifiedSchoolIdentity = identity;
  // Compatibility for routes/tests that still consume the previous singular
  // provenance. It is deterministic and always reflects the primary role.
  res.locals.verifiedSchoolMembership = {
    userId: identity.userId,
    schoolId: identity.schoolId,
    role: identity.primaryRole,
  };
}

function requestedSchoolId(req: Parameters<RequestHandler>[0]): string {
  return (
    String(req.params.schoolId || "") ||
    (req.headers["x-school-id"] as string) ||
    (req.query.schoolId as string) ||
    ""
  );
}

function applySessionIdentity(
  req: Parameters<RequestHandler>[0],
  identity: VerifiedSchoolIdentity
): void {
  if (req.authMethod !== "session") return;
  req.session.schoolId = identity.schoolId;
  req.session.role = identity.primaryRole;
  req.session.schoolSessionVersion = identity.school.schoolSessionVersion ?? 1;
}

/**
 * Resolves one deterministic school identity and every active role in that
 * school. The request body is never an authority source. Multiple schools
 * without an explicit/session selection are observed first and fail with a
 * stable 409 once MEMBERSHIP_RESOLVER_MODE=enforce.
 */
const resolveSchoolContext: RequestHandler = async (req, res, next) => {
  if (!req.authUser) {
    return res.status(401).json({ error: "Authentication required" });
  }

  if (req.authUser.isSuperAdmin) {
    const schoolId = requestedSchoolId(req) || req.session?.schoolId;
    if (schoolId) res.locals.schoolId = schoolId;
    res.locals.membershipRole = "super_admin";
    res.locals.membershipRoles = ["super_admin"];
    return next();
  }

  const requested = requestedSchoolId(req);

  if (req.authMethod === "session" && req.session?.schoolId) {
    const selectedSchoolId = requested || req.session.schoolId;
    const [identity] = await loadIdentities(req.authUser.id, selectedSchoolId);
    if (!identity) {
      return res.status(requested ? 404 : 403).json({
        error: requested ? "School not found" : "No access to this school",
      });
    }
    applySessionIdentity(req, identity);
    applyVerifiedIdentity(res, identity);
    return next();
  }

  if (requested) {
    const [identity] = await loadIdentities(req.authUser.id, requested);
    if (!identity) {
      return res.status(403).json({ error: "No access to this school" });
    }
    applySessionIdentity(req, identity);
    applyVerifiedIdentity(res, identity);
    return next();
  }

  const identities = await loadIdentities(req.authUser.id);
  if (identities.length === 0) {
    return res.status(400).json({ error: "No school context available" });
  }
  if (identities.length > 1) {
    ambiguousSelectionCount += 1;
    if (membershipResolverMode() === "enforce") {
      return res.status(409).json({
        error: "Select a school before continuing",
        code: "SCHOOL_SELECTION_REQUIRED",
      });
    }
  }

  // Observe mode preserves compatibility while removing nondeterminism: the
  // loader orders by earliest active membership and then school ID.
  const identity = identities[0]!;
  applySessionIdentity(req, identity);
  applyVerifiedIdentity(res, identity);
  return next();
};

/**
 * Resolves and authorizes the school without checking out a response-lifetime
 * RLS client. Callers must establish a narrow runWithTenantContext scope (or
 * invoke bindTenantContext) before touching any tenant table.
 */
export const requireSchoolContextWithoutTenantBinding: RequestHandler = (
  req,
  res,
  next
) => {
  void Promise.resolve(resolveSchoolContext(req, res, next)).catch(next);
};

export const requireSchoolContext: RequestHandler = (req, res, next) => {
  void Promise.resolve(
    resolveSchoolContext(req, res, (error?: unknown) => {
      if (error) return next(error);
      return bindTenantContext(req, res, next);
    })
  ).catch(next);
};
