import "express-session";
import type { User as SchemaUser, School as SchemaSchool } from "../schema/core.js";
import type { SchoolRole, VerifiedSchoolIdentity } from "../services/schoolIdentity.js";

declare module "express-session" {
  interface SessionData {
    userId: string;
    email: string;
    role: string; // admin | teacher | office_staff | super_admin
    schoolId: string | null;
    schoolSessionVersion: number;
    authVersion?: number;
    lastActivityAt?: number;
    csrfToken: string;
    googleOAuthState?: string;
    googleOAuthNonce?: string;
    googleOAuthRedirect?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      authUser?: SchemaUser;
      authMethod?: "session" | "jwt";
      jwtPayload?: {
        userId: string;
        email: string;
        isSuperAdmin?: boolean;
        authVersion?: number;
      };
      rawBody?: Buffer;
      // Per-request correlation id (set by requestId middleware, echoed in the
      // X-Request-Id response header and recorded on any error for this request)
      requestId?: string;
      // Immutable app-ingress clock captured alongside requestId before any
      // asynchronous middleware or rate limiter.
      requestReceivedAtMs?: number;
    }

    interface Locals {
      schoolId?: string;
      school?: SchemaSchool;
      schoolActive?: boolean;
      // Canonical authorization identity. membershipRole remains the
      // deterministic legacy display role and must not be used as a gate.
      schoolIdentity?: VerifiedSchoolIdentity;
      verifiedSchoolIdentity?: VerifiedSchoolIdentity;
      membershipRole?: SchoolRole | "super_admin";
      membershipRoles?: Array<SchoolRole | "super_admin">;
      // Device auth (ClassPilot)
      studentId?: string;
      deviceId?: string;
      studentEmail?: string;
      authType?: "session" | "jwt" | "device";
    }
  }
}
