import "express-session";
import type { User as SchemaUser, School as SchemaSchool } from "../schema/core.js";

declare module "express-session" {
  interface SessionData {
    userId: string;
    email: string;
    role: string; // admin | teacher | office_staff | super_admin
    schoolId: string | null;
    schoolSessionVersion: number;
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
