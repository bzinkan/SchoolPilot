import "express-session";
import type { User as SchemaUser, School as SchemaSchool } from "../schema/core.js";

declare module "express-session" {
  interface SessionData {
    userId: string;
    email: string;
    role: string; // admin | teacher | office_staff | super_admin
    schoolId: string | null;
    schoolSessionVersion: number;
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
      };
      rawBody?: Buffer;
      // Per-request correlation id (set by requestId middleware, echoed in the
      // X-Request-Id response header and recorded on any error for this request)
      requestId?: string;
    }

    interface Locals {
      schoolId?: string;
      school?: SchemaSchool;
      schoolActive?: boolean;
      // Device auth (ClassPilot)
      studentId?: string;
      deviceId?: string;
      studentEmail?: string;
      authType?: "session" | "jwt" | "device";
    }
  }
}
