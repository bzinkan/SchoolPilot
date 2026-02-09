import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "schoolpilot-dev-jwt-secret-at-least-32-bytes";
const JWT_EXPIRY = process.env.JWT_EXPIRY || "7d";

export interface UserJwtPayload {
  userId: string;
  email: string;
  isSuperAdmin?: boolean;
}

export function signUserToken(payload: UserJwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRY as string & jwt.SignOptions["expiresIn"],
  });
}

export function verifyUserToken(token: string): UserJwtPayload {
  return jwt.verify(token, JWT_SECRET) as UserJwtPayload;
}
