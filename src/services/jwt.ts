import jwt from "jsonwebtoken";
import crypto from "crypto";

const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !process.env.JWT_SECRET) {
  throw new Error(
    "FATAL: JWT_SECRET environment variable is required in production"
  );
}

const JWT_SECRET =
  process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const JWT_EXPIRY = process.env.JWT_EXPIRY || "7d";

/**
 * JWT payload for user authentication (GoPilot mobile, cross-app tokens).
 *
 * isSuperAdmin is included so that clients can show/hide admin UI without an
 * extra round-trip. It is never trusted blindly — the authenticate middleware
 * always re-validates the user record from the database before granting
 * super-admin privileges.
 */
export interface UserJwtPayload {
  userId: string;
  email: string;
  isSuperAdmin?: boolean;
}

export function signUserToken(payload: UserJwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: JWT_EXPIRY as string & jwt.SignOptions["expiresIn"],
  });
}

export function verifyUserToken(token: string): UserJwtPayload {
  return jwt.verify(token, JWT_SECRET, {
    algorithms: ["HS256"],
  }) as UserJwtPayload;
}
