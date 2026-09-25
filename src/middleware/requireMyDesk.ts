import type { Request, RequestHandler, Response } from "express";
import { requestSchoolIdentity } from "../services/schoolAuthorization.js";
import { myDeskEnabledForSchool } from "../services/mydeskValidation.js";
import { loadVerifiedSchoolIdentities } from "../services/schoolIdentity.js";

export type MyDeskActor = { schoolId: string; authorId: string; manager: boolean };
export const rejectMyDeskPrivilegedAccess: RequestHandler = (req, res, next) => {
  if (req.session?.impersonating || req.session?.originalUserId) {
    res.status(403).json({ error: "My Desk is unavailable during administrator support access", code: "MYDESK_PRIVATE_ACCESS_REQUIRED" });
    return;
  }
  next();
};
export function myDeskActor(req: Request, res: Response): MyDeskActor {
  const identity = requestSchoolIdentity(req, res);
  if (req.session?.impersonating || req.session?.originalUserId
    || !identity || !identity.roles.some(role => ["teacher", "admin", "school_admin"].includes(role))) {
    throw Object.assign(new Error("My Desk requires your own active staff identity"), { status: 403, code: "MYDESK_PRIVATE_ACCESS_REQUIRED" });
  }
  return { schoolId: identity.schoolId, authorId: identity.userId, manager: identity.roles.some(role => role === "admin" || role === "school_admin") };
}
export const requireMyDeskAuthor: RequestHandler = (req, res, next) => {
  void (async () => {
    if (!req.authUser || !res.locals.schoolId || req.session?.impersonating || req.session?.originalUserId) {
      throw Object.assign(new Error("Your own active staff identity is required"), { status: 403, code: "MYDESK_PRIVATE_ACCESS_REQUIRED" });
    }
    // The normal school resolver deliberately bypasses super administrators.
    // My Desk requires an actual active membership even for that account type.
    const [identity] = await loadVerifiedSchoolIdentities(req.authUser.id, res.locals.schoolId);
    if (!identity) throw Object.assign(new Error("Your school membership is no longer active"), { status: 403, code: "MYDESK_MEMBERSHIP_INACTIVE" });
    res.locals.schoolIdentity = identity;
    res.locals.verifiedSchoolIdentity = identity;
    res.locals.school = identity.school;
    myDeskActor(req, res); next();
  })().catch(next);
};
export const requireMyDeskEnabled: RequestHandler = (req, res, next) => {
  if (!myDeskEnabledForSchool(myDeskActor(req, res).schoolId)) {
    res.status(404).json({ error: "My Desk is not enabled for this school", code: "MYDESK_NOT_ENABLED" }); return;
  }
  next();
};
